#include "sync.hpp"
#include "discovery.hpp"
#include "site.hpp"
#include <obs-module.h>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>

namespace overlay {
struct CachedHash {
	qint64 size = -1;
	qint64 mtime = 0;
	QString hash;
};

static QHash<QString, CachedHash> g_hashes;
static QElapsedTimer g_last_sync;
static bool g_synced_once = false;

qint64 ms_since_last_sync() { return g_synced_once ? g_last_sync.elapsed() : ((qint64)1 << 40); }

static SyncReply plain(int code, const char *text)
{
	SyncReply r;
	r.code = code;
	r.type = "application/json";
	QJsonObject o;
	o["error"] = QString::fromUtf8(text);
	r.body = QJsonDocument(o).toJson(QJsonDocument::Compact);
	return r;
}

static SyncReply empty(int code)
{
	SyncReply r;
	r.code = code;
	return r;
}

static QString file_hash(const QString &path, const QFileInfo &fi)
{
	QHash<QString, CachedHash>::iterator it = g_hashes.find(path);
	const qint64 mtime = fi.lastModified().toMSecsSinceEpoch();
	if (it != g_hashes.end() && it->size == fi.size() && it->mtime == mtime) return it->hash;
	QFile f(path);
	if (!f.open(QIODevice::ReadOnly)) return QString();
	QCryptographicHash h(QCryptographicHash::Sha256);
	h.addData(&f);
	CachedHash c;
	c.size = fi.size();
	c.mtime = mtime;
	c.hash = QString::fromLatin1(h.result().toHex());
	g_hashes.insert(path, c);
	return c.hash;
}

static SyncReply manifest()
{
	QJsonObject files;
	QHash<QString, CachedHash> keep;
	const QDir root(site_dir());
	QDirIterator it(site_dir(), QDir::Files | QDir::NoSymLinks, QDirIterator::Subdirectories);
	while (it.hasNext()) {
		const QString path = it.next();
		const QFileInfo fi = it.fileInfo();
		const QString h = file_hash(path, fi);
		if (h.isEmpty()) continue;
		files[root.relativeFilePath(path)] = h;
		keep.insert(path, g_hashes.value(path));
	}
	g_hashes = keep;
	QJsonObject o;
	o["files"] = files;
	SyncReply r;
	r.body = QJsonDocument(o).toJson(QJsonDocument::Compact);
	return r;
}

static QByteArray bearer(const QByteArray &auth)
{
	static const QByteArray prefix = "Bearer ";
	if (auth.size() < prefix.size() || auth.left(prefix.size()).toLower() != prefix.toLower()) return QByteArray();
	return auth.mid(prefix.size()).trimmed();
}

SyncReply handle_sync(const QByteArray &method, const QByteArray &raw_path, const QByteArray &auth,
		      const QByteArray &body)
{
	const QByteArray presented = bearer(auth);
	if (!token_matches(presented)) return plain(401, "A valid token is needed.");
	g_last_sync.start();
	g_synced_once = true;

	if (raw_path == "/sync/manifest") {
		if (method != "GET") return plain(405, "Use GET for the manifest.");
		return manifest();
	}
	static const QByteArray prefix = "/sync/files/";
	if (!raw_path.startsWith(prefix)) return plain(404, "Unknown sync route.");
	if (method != "PUT" && method != "DELETE") return plain(405, "Use PUT or DELETE for files.");

	QString rel;
	// Reuse the request path rules by treating the part after /sync/files as a path of its own.
	if (!clean_request_path("/" + raw_path.mid(prefix.size()), &rel) || rel.isEmpty() || rel.endsWith('/'))
		return plain(400, "That path is not allowed.");
	if (!write_allowed(rel)) return plain(403, "That folder cannot be changed.");
	QString file;
	if (!resolve_write(rel, &file)) return plain(400, "That path is not allowed.");

	if (method == "DELETE") {
		if (QFileInfo::exists(file) && !QFile::remove(file)) return plain(500, "Could not delete the file.");
		g_hashes.remove(QDir::cleanPath(file));
		return empty(204);
	}

	if (!QDir().mkpath(QFileInfo(file).absolutePath())) return plain(500, "Could not create the folder.");
	// Check again now that the folders exist, in case a link now leads outside.
	QString again;
	if (!resolve_write(rel, &again)) return plain(400, "That path is not allowed.");
	QSaveFile f(file);
	if (!f.open(QIODevice::WriteOnly)) return plain(500, "Could not write the file.");
	if (f.write(body) != body.size()) {
		f.cancelWriting();
		return plain(500, "Could not write the file.");
	}
	if (!f.commit()) return plain(500, "Could not save the file.");
	return empty(204);
}
} // namespace overlay
