// Small HTTP server bound to 127.0.0.1 only: the overlay pages, /api proxy, mirror and sync routes.
#include "http-server.hpp"
#include "site.hpp"
#include "sync.hpp"
#include "discovery.hpp"
#include <obs-module.h>
#include <plugin-support.h>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QMutex>
#include <QNetworkAccessManager>
#include <QNetworkProxy>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPointer>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>
#include <QUrl>
#include <QRegularExpression>
#include <memory>

namespace overlay {
static const qint64 kMaxBody = 32 * 1024 * 1024;
static const int kMaxHeaderBytes = 64 * 1024;
static const int kIdleMs = 10000;
static const int kProxyTimeoutMs = 5000;

static QTcpServer *g_server = nullptr;
static QNetworkAccessManager *g_net = nullptr;
static QMutex g_frame_mutex;
static QByteArray g_frame;
static QElapsedTimer g_last_request;
static bool g_requested_once = false;
static QString g_bundled;
static QString g_runtime_site;

static const char *kSeedIndex = R"HTML(<!doctype html><meta charset="utf-8"><title>ChaosBot Overlay</title>
<body style="margin:0;background:#202040;color:#fff;font:32px sans-serif">
<p style="padding:20px">Open ChaosBot once so it can copy your overlay here.</p>
</body>)HTML";

struct Request {
	QByteArray method;
	QByteArray target; // path and query, as sent
	QByteArray path;   // target before "?"
	QHash<QByteArray, QByteArray> headers; // names in lower case
	QByteArray body;
};

static QByteArray content_type(const QString &path)
{
	const QString p = path.toLower();
	static const struct {
		const char *ext;
		const char *type;
	} kTypes[] = {{".html", "text/html; charset=utf-8"},
		      {".htm", "text/html; charset=utf-8"},
		      {".js", "text/javascript; charset=utf-8"},
		      {".mjs", "text/javascript; charset=utf-8"},
		      {".css", "text/css; charset=utf-8"},
		      {".json", "application/json"},
		      {".png", "image/png"},
		      {".jpg", "image/jpeg"},
		      {".jpeg", "image/jpeg"},
		      {".gif", "image/gif"},
		      {".webp", "image/webp"},
		      {".svg", "image/svg+xml"},
		      {".woff2", "font/woff2"},
		      {".mp3", "audio/mpeg"},
		      {".ogg", "audio/ogg"},
		      {".wav", "audio/wav"},
		      {".ico", "image/x-icon"}};
	for (const auto &t : kTypes)
		if (p.endsWith(QLatin1String(t.ext))) return t.type;
	return "application/octet-stream";
}

static const char *reason(int code)
{
	switch (code) {
	case 200: return "OK";
	case 204: return "No Content";
	case 400: return "Bad Request";
	case 401: return "Unauthorized";
	case 403: return "Forbidden";
	case 404: return "Not Found";
	case 405: return "Method Not Allowed";
	case 411: return "Length Required";
	case 413: return "Payload Too Large";
	case 421: return "Misdirected Request";
	case 431: return "Request Header Fields Too Large";
	case 500: return "Internal Server Error";
	case 501: return "Not Implemented";
	case 502: return "Bad Gateway";
	default: return "OK";
	}
}

static void reply(const QPointer<QTcpSocket> &s, int code, const QByteArray &type, const QByteArray &body)
{
	if (!s) return;
	QByteArray h = "HTTP/1.1 " + QByteArray::number(code) + " " + reason(code) + "\r\nContent-Type: " + type +
		       "\r\nContent-Length: " + QByteArray::number(body.size()) +
		       "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nAccess-Control-Allow-Origin: http://127.0.0.1:5261\r\nConnection: close\r\n\r\n";
	s->write(h);
	if (code != 204) s->write(body);
	s->disconnectFromHost();
}

static void reply_text(const QPointer<QTcpSocket> &s, int code, const char *text)
{
	reply(s, code, "text/plain; charset=utf-8", text);
}

static bool host_ok(const QByteArray &host)
{
	const QByteArray h = host.trimmed().toLower();
	return h == "127.0.0.1:5260" || h == "localhost:5260";
}

static void proxy_api(const QPointer<QTcpSocket> &s, const Request &r)
{
	if (!g_net) {
		reply_text(s, 502, "ChaosBot is not running.");
		return;
	}
	QNetworkRequest req(QUrl::fromEncoded("http://127.0.0.1:5261" + r.target));
	req.setTransferTimeout(kProxyTimeoutMs);
	QNetworkReply *rep = g_net->get(req);
	QObject::connect(rep, &QNetworkReply::finished, rep, [s, rep] {
		const QVariant status = rep->attribute(QNetworkRequest::HttpStatusCodeAttribute);
		if (!status.isValid()) {
			reply_text(s, 502, "ChaosBot is not running.");
		} else {
			QByteArray type = rep->header(QNetworkRequest::ContentTypeHeader).toByteArray();
			if (type.isEmpty()) type = "application/octet-stream";
			int code = status.toInt();
			reply(s, code, type, rep->readAll());
		}
		rep->deleteLater();
	});
}

static void serve_static(const QPointer<QTcpSocket> &s, const Request &r)
{
	QString rel;
	if (!clean_request_path(r.path, &rel)) {
		reply_text(s, 400, "That path is not allowed.");
		return;
	}
	if (rel.startsWith("scene/")) rel = "scene/";
	QString file;
	QFile f;
	const bool companion = rel == "companion/";
	if (companion) {
		if (!resolve_read("index.html", &file)) { reply_text(s, 404, "ChaosBot has not connected."); return; }
	} else if (rel.isEmpty() || rel == "index.html" || rel == "source.js" || rel == "chaos/signalr.min.js" || rel == "scene/" || rel.startsWith("spotify/") || rel.startsWith("ui/")) {
		file = g_bundled + "/" + rel;
		if (QFileInfo(file).isDir()) file += "/index.html";
	} else if (rel.startsWith("overlay/") && QFileInfo::exists(g_runtime_site + "/" + rel)) {
		file = QFileInfo(g_runtime_site + "/" + rel).canonicalFilePath();
		if (!file.startsWith(QDir(g_runtime_site).canonicalPath() + "/", Qt::CaseInsensitive)) { reply_text(s, 400, "That path is not allowed."); return; }
	} else if (!resolve_read(rel, &file)) {
		reply_text(s, 404, "Not found."); return;
	}
	if ((f.setFileName(file), !f.open(QIODevice::ReadOnly))) {
		reply_text(s, 404, "Not found.");
		return;
	}
	QByteArray contents = f.readAll();
	if (companion) {
		QString html = QString::fromUtf8(contents);
		html.remove(QRegularExpression("<iframe[^>]*id=\"layout\"[^>]*></iframe>"));
		contents = html.toUtf8();
	}
	reply(s, 200, content_type(file), contents);
}

static void dispatch(const QPointer<QTcpSocket> &s, const Request &r)
{
	if (!host_ok(r.headers.value("host"))) {
		reply_text(s, 421, "Wrong host.");
		return;
	}
	if (r.path.startsWith("/sync/")) {
		if (r.path == "/sync/state") {
			QByteArray auth=r.headers.value("authorization");
			if (!auth.startsWith("Bearer ") || !token_matches(auth.mid(7))) { reply_text(s,401,"Sign in to sync."); return; }
			if (r.method != "GET" && r.method != "PUT") {reply_text(s,405,"Use GET or PUT.");return;}
			QNetworkRequest req(QUrl("http://127.0.0.1:5261/api/internal/scenes"));
			req.setRawHeader("Authorization", auth);req.setHeader(QNetworkRequest::ContentTypeHeader,"application/json");req.setTransferTimeout(5000);
			auto *rep=r.method=="GET"?g_net->get(req):g_net->put(req,r.body);
			QObject::connect(rep,&QNetworkReply::finished,rep,[s,rep]{ const auto status=rep->attribute(QNetworkRequest::HttpStatusCodeAttribute);reply(s,status.isValid()?status.toInt():502,"application/json",rep->readAll());rep->deleteLater(); });
			return;
		}
		const SyncReply sr = handle_sync(r.method, r.path, r.headers.value("authorization"), r.body);
		reply(s, sr.code, sr.type, sr.body);
		return;
	}
	if (r.method != "GET") {
		reply_text(s, 405, "Use GET.");
		return;
	}
	if (r.path == "/health") {
		reply(s, 200, "application/json",
		      QByteArray("{\"ok\":true,\"standalone\":true,\"version\":\"") + PLUGIN_VERSION + "\"}");
		return;
	}
	if (r.path == "/mirror.jpg") {
		QMutexLocker l(&g_frame_mutex);
		g_last_request.start();
		g_requested_once = true;
		if (g_frame.isEmpty())
			reply_text(s, 404, "No frame yet.");
		else
			reply(s, 200, "image/jpeg", g_frame);
		return;
	}
	if (r.path.startsWith("/api/")) {
		if (r.path.startsWith("/api/private/") || r.path.startsWith("/api/internal/")) { reply_text(s, 403, "Use the editor panel."); return; }
		QString ignored;
		if (!clean_request_path(r.path, &ignored)) {
			reply_text(s, 400, "That path is not allowed.");
			return;
		}
		proxy_api(s, r);
		return;
	}
	serve_static(s, r);
}

struct Conn {
	QByteArray buf;
	bool done = false;
};

// Looks at what has arrived. Returns when more bytes are needed or the request was answered.
static void process(const QPointer<QTcpSocket> &s, Conn &c, QTimer *idle)
{
	if (c.done) return;
	const int head_end = c.buf.indexOf("\r\n\r\n");
	if (head_end < 0) {
		if (c.buf.size() > kMaxHeaderBytes) {
			c.done = true;
			reply_text(s, 431, "Headers too large.");
		}
		return;
	}
	Request r;
	const QList<QByteArray> lines = c.buf.left(head_end).split('\n');
	const QList<QByteArray> first = lines[0].trimmed().split(' ');
	if (first.size() != 3 || !first[2].startsWith("HTTP/")) {
		c.done = true;
		reply_text(s, 400, "Bad request.");
		return;
	}
	r.method = first[0];
	r.target = first[1];
	r.path = r.target.split('?')[0];
	for (int i = 1; i < lines.size(); i++) {
		const int colon = lines[i].indexOf(':');
		if (colon <= 0) continue;
		const QByteArray name = lines[i].left(colon).trimmed().toLower();
		if (!r.headers.contains(name)) r.headers.insert(name, lines[i].mid(colon + 1).trimmed());
	}
	if (r.headers.contains("transfer-encoding")) {
		c.done = true;
		reply_text(s, 501, "Chunked bodies are not supported.");
		return;
	}
	qint64 len = 0;
	if (r.headers.contains("content-length")) {
		bool ok = false;
		len = r.headers.value("content-length").toLongLong(&ok);
		if (!ok || len < 0) {
			c.done = true;
			reply_text(s, 400, "Bad Content-Length.");
			return;
		}
		if (len > kMaxBody) {
			c.done = true;
			reply_text(s, 413, "Body too large.");
			return;
		}
	}
	const qint64 body_start = head_end + 4;
	if (c.buf.size() < body_start + len) return; // wait for the rest
	r.body = c.buf.mid(body_start, (qsizetype)len);
	c.done = true;
	idle->stop();
	dispatch(s, r);
}

bool start_http_server()
{
	if (g_server) return true;
	char *dir = obs_module_config_path("site");
	const QString site = QString::fromUtf8(dir);
	bfree(dir);
	site_init(site);
	char *saved=obs_module_config_path("runtime-site");g_runtime_site=QString::fromUtf8(saved?saved:"");bfree(saved);
	char *bundled = obs_module_file("site");
	g_bundled = QString::fromUtf8(bundled ? bundled : "");
	bfree(bundled);
	if (!QFileInfo::exists(site_dir() + "/index.html")) {
		QFile f(site_dir() + "/index.html");
		if (f.open(QIODevice::WriteOnly)) f.write(kSeedIndex);
	}

	g_net = new QNetworkAccessManager();
	g_net->setProxy(QNetworkProxy::NoProxy);

	g_server = new QTcpServer();
	QObject::connect(g_server, &QTcpServer::newConnection, g_server, [] {
		while (QTcpSocket *s = g_server->nextPendingConnection()) {
			auto conn = std::make_shared<Conn>();
			auto *idle = new QTimer(s);
			idle->setSingleShot(true);
			QObject::connect(idle, &QTimer::timeout, s, [s] { s->abort(); });
			idle->start(kIdleMs);
			QPointer<QTcpSocket> ptr(s);
			QObject::connect(s, &QTcpSocket::readyRead, s, [ptr, conn, idle] {
				if (!ptr) return;
				conn->buf.append(ptr->readAll());
				idle->start(kIdleMs);
				process(ptr, *conn, idle);
			});
			QObject::connect(s, &QTcpSocket::disconnected, s, &QObject::deleteLater);
		}
	});
	if (!g_server->listen(QHostAddress::LocalHost, kPluginPort)) {
		obs_log(LOG_WARNING, "could not listen on port %d: %s", kPluginPort, qPrintable(g_server->errorString()));
		delete g_server;
		g_server = nullptr;
		delete g_net;
		g_net = nullptr;
		return false;
	}
	obs_log(LOG_INFO, "serving %s on http://127.0.0.1:%d/", qPrintable(site_dir()), kPluginPort);
	return true;
}

void stop_http_server()
{
	delete g_server;
	g_server = nullptr;
	delete g_net;
	g_net = nullptr;
}

void set_mirror_frame(const QByteArray &jpeg)
{
	QMutexLocker l(&g_frame_mutex);
	g_frame = jpeg;
}

qint64 ms_since_mirror_request()
{
	QMutexLocker l(&g_frame_mutex);
	return g_requested_once ? g_last_request.elapsed() : ((qint64)1 << 40);
}
} // namespace overlay
