// Native tests for the parts of the plugin ChaosBot talks to: the discovery file, the sync
// routes and the site path rules. They run without OBS; obs_log is stubbed below.
#include "discovery.hpp"
#include "site.hpp"
#include "sync.hpp"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>
#include <cstdio>
#include <functional>
#include <utility>
#include <vector>

extern "C" {
const char *PLUGIN_NAME = "chaosbot-overlay";
const char *PLUGIN_VERSION = "9.9.9-test";
void obs_log(int, const char *, ...) {}
}

using namespace overlay;

static int g_failures = 0;
static const char *g_test = "";

#define CHECK(cond)                                                                           \
	do {                                                                                  \
		if (!(cond)) {                                                                \
			std::fprintf(stderr, "FAIL %s (line %d): %s\n", g_test, __LINE__, #cond); \
			g_failures++;                                                         \
		}                                                                             \
	} while (0)

static QByteArray auth() { return "Bearer " + session_token(); }

static QJsonObject json(const QByteArray &body) { return QJsonDocument::fromJson(body).object(); }

static QByteArray read_bytes(const QString &path)
{
	QFile f(path);
	return f.open(QIODevice::ReadOnly) ? f.readAll() : QByteArray();
}

static QByteArray sha(const QByteArray &body) { return QCryptographicHash::hash(body, QCryptographicHash::Sha256).toHex(); }

static QByteArray manifest_hash(const char *rel)
{
	const SyncReply m = handle_sync("GET", "/sync/manifest", auth(), "");
	return json(m.body)["files"].toObject()[rel].toString().toLatin1();
}

static void token_is_64_hex_and_compares_exactly()
{
	const QByteArray &t = session_token();
	CHECK(t.size() == 64);
	CHECK(QByteArray::fromHex(t).toHex() == t);
	CHECK(session_token() == t);
	CHECK(token_matches(t));
	CHECK(!token_matches(t.left(63)));
	CHECK(!token_matches(t + "0"));
	CHECK(!token_matches(QByteArray()));
	QByteArray flipped = t;
	flipped[10] = flipped[10] == 'a' ? 'b' : 'a';
	CHECK(!token_matches(flipped));
}

static void discovery_file_has_what_chaosbot_reads(const QString &data_dir)
{
	CHECK(write_discovery(4455));
	const QJsonObject o = json(read_bytes(data_dir + "/plugin.json"));
	CHECK(o["port"].toInt() == 4455);
	CHECK(o["token"].toString().toLatin1() == session_token());
	CHECK((qint64)o["pid"].toDouble() == QCoreApplication::applicationPid());
	CHECK(o["version"].toString() == "9.9.9-test");
	// ChaosBot only uses two-way sync when this is true. An old plugin leaves it out.
	CHECK(o["standalone"].toBool());

	remove_discovery();
	CHECK(!QFile::exists(data_dir + "/plugin.json"));
}

static void discovery_is_left_alone_when_another_obs_owns_it(const QString &data_dir)
{
	QFile f(data_dir + "/plugin.json");
	CHECK(f.open(QIODevice::WriteOnly));
	f.write(R"({"port":1,"token":"x","pid":1})");
	f.close();
	remove_discovery();
	CHECK(QFile::exists(data_dir + "/plugin.json"));
	QFile::remove(data_dir + "/plugin.json");
}

static void sync_needs_the_token()
{
	CHECK(handle_sync("GET", "/sync/manifest", "", "").code == 401);
	CHECK(handle_sync("GET", "/sync/manifest", "Bearer nope", "").code == 401);
	CHECK(handle_sync("GET", "/sync/manifest", "Basic " + session_token(), "").code == 401);
	CHECK(handle_sync("GET", "/sync/manifest", "bearer " + session_token(), "").code == 200);
}

static void sync_rejects_wrong_methods_and_routes()
{
	CHECK(handle_sync("PUT", "/sync/manifest", auth(), "").code == 405);
	CHECK(handle_sync("GET", "/sync/files/scene/a.json", auth(), "").code == 405);
	CHECK(handle_sync("GET", "/sync/other", auth(), "").code == 404);
}

static void put_then_manifest_then_delete()
{
	const QByteArray body = R"({"layers":[]})";
	CHECK(handle_sync("PUT", "/sync/files/scene/layout.json", auth(), body).code == 204);
	CHECK(read_bytes(site_dir() + "/scene/layout.json") == body);
	CHECK(manifest_hash("scene/layout.json") == sha(body));

	// The manifest caches hashes by size and time, so a rewrite must still show the new hash.
	const QByteArray changed = R"({"layers":[1]})";
	CHECK(handle_sync("PUT", "/sync/files/scene/layout.json", auth(), changed).code == 204);
	CHECK(manifest_hash("scene/layout.json") == sha(changed));

	CHECK(handle_sync("DELETE", "/sync/files/scene/layout.json", auth(), "").code == 204);
	CHECK(!QFile::exists(site_dir() + "/scene/layout.json"));
	CHECK(manifest_hash("scene/layout.json").isEmpty());
	// Deleting a file that is already gone is not an error.
	CHECK(handle_sync("DELETE", "/sync/files/scene/layout.json", auth(), "").code == 204);
}

static void sync_writes_only_inside_the_allowed_folders()
{
	CHECK(handle_sync("PUT", "/sync/files/index.html", auth(), "<p>").code == 204);
	CHECK(handle_sync("PUT", "/sync/files/plugin.json", auth(), "{}").code == 403);
	CHECK(handle_sync("PUT", "/sync/files/editor/index.html", auth(), "x").code == 403);
	CHECK(handle_sync("PUT", "/sync/files/scene/", auth(), "x").code == 400);
	for (const char *bad : {"/sync/files/scene/../../evil.txt", "/sync/files/scene/%2e%2e/evil.txt",
				"/sync/files/scene\\evil.txt", "/sync/files/scene/c:evil.txt", "/sync/files/scene/con.txt",
				"/sync/files/scene/evil.", "/sync/files/scene//evil.txt", "/sync/files/scene/a%00b"}) {
		const int code = handle_sync("PUT", bad, auth(), "x").code;
		CHECK(code == 400);
		if (code != 400) std::fprintf(stderr, "  path %s gave %d\n", bad, code);
	}
	CHECK(!QFile::exists(QDir(site_dir()).absoluteFilePath("../evil.txt")));
}

static void request_paths_resolve_inside_the_site()
{
	QString rel;
	CHECK(clean_request_path("/", &rel) && rel.isEmpty());
	CHECK(clean_request_path("/scene/index.html", &rel) && rel == "scene/index.html");
	CHECK(clean_request_path("/a%20b.png", &rel) && rel == "a b.png");
	CHECK(!clean_request_path("scene", &rel));
	CHECK(!clean_request_path("//host/share", &rel));
	CHECK(!clean_request_path("/lpt1", &rel));

	QDir(site_dir()).mkpath("scene");
	QFile f(site_dir() + "/scene/index.html");
	CHECK(f.open(QIODevice::WriteOnly));
	f.close();
	QString file;
	CHECK(resolve_read("scene", &file) && file.endsWith("/scene/index.html"));
	CHECK(!resolve_read("missing.html", &file) && file.isEmpty());
}

int main(int argc, char **argv)
{
	QCoreApplication app(argc, argv);
	QTemporaryDir root;
	if (!root.isValid()) return 2;
	const QString data_dir = root.path() + "/data";
	QDir().mkpath(data_dir);
	qputenv("CHAOSBOT_OVERLAY_DATA_DIR", data_dir.toUtf8());
	site_init(root.path() + "/site");

	const std::vector<std::pair<const char *, std::function<void()>>> tests = {
		{"token_is_64_hex_and_compares_exactly", token_is_64_hex_and_compares_exactly},
		{"discovery_file_has_what_chaosbot_reads", [&] { discovery_file_has_what_chaosbot_reads(data_dir); }},
		{"discovery_is_left_alone_when_another_obs_owns_it",
		 [&] { discovery_is_left_alone_when_another_obs_owns_it(data_dir); }},
		{"sync_needs_the_token", sync_needs_the_token},
		{"sync_rejects_wrong_methods_and_routes", sync_rejects_wrong_methods_and_routes},
		{"put_then_manifest_then_delete", put_then_manifest_then_delete},
		{"sync_writes_only_inside_the_allowed_folders", sync_writes_only_inside_the_allowed_folders},
		{"request_paths_resolve_inside_the_site", request_paths_resolve_inside_the_site},
	};
	for (const auto &t : tests) {
		g_test = t.first;
		const int before = g_failures;
		t.second();
		std::printf("%s %s\n", g_failures == before ? "ok  " : "FAIL", t.first);
	}
	std::printf("%zu tests, %d failed checks\n", tests.size(), g_failures);
	return g_failures == 0 ? 0 : 1;
}
