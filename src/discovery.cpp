#include "discovery.hpp"
#include <obs-module.h>
#include <plugin-support.h>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRandomGenerator>
#include <QSaveFile>
#include <cstring>

namespace overlay {
static QByteArray g_token;

const QByteArray &session_token()
{
	if (g_token.isEmpty()) {
		QByteArray raw(32, 0);
		QRandomGenerator *rng = QRandomGenerator::system();
		for (int i = 0; i < 32; i += 4) {
			const quint32 v = rng->generate();
			memcpy(raw.data() + i, &v, 4);
		}
		g_token = raw.toHex();
	}
	return g_token;
}

bool token_matches(const QByteArray &presented)
{
	const QByteArray &t = session_token();
	// Walk the longer length so timing does not reveal where the first difference is.
	const int n = qMax(t.size(), presented.size());
	unsigned diff = (unsigned)(t.size() ^ presented.size());
	for (int i = 0; i < n; i++) {
		const unsigned a = i < t.size() ? (unsigned char)t[i] : 0;
		const unsigned b = i < presented.size() ? (unsigned char)presented[i] : 0;
		diff |= a ^ b;
	}
	return diff == 0;
}

// CHAOSBOT_OVERLAY_DATA_DIR is for tests only, so a test run does not touch the real file.
static QString discovery_dir()
{
	QString base = qEnvironmentVariable("CHAOSBOT_OVERLAY_DATA_DIR");
	if (base.isEmpty()) base = qEnvironmentVariable("LOCALAPPDATA") + "/ChaosBot Overlay";
	return base;
}

static QString discovery_path() { return discovery_dir() + "/plugin.json"; }

bool write_discovery(quint16 port)
{
	QDir().mkpath(discovery_dir());
	QJsonObject o;
	o["port"] = (int)port;
	o["token"] = QString::fromLatin1(session_token());
	o["pid"] = (double)QCoreApplication::applicationPid();
	o["version"] = QString::fromUtf8(PLUGIN_VERSION);
	QSaveFile f(discovery_path());
	if (!f.open(QIODevice::WriteOnly)) {
		obs_log(LOG_WARNING, "could not write %s", qPrintable(discovery_path()));
		return false;
	}
	f.write(QJsonDocument(o).toJson(QJsonDocument::Compact));
	if (!f.commit()) {
		obs_log(LOG_WARNING, "could not save %s", qPrintable(discovery_path()));
		return false;
	}
	obs_log(LOG_INFO, "wrote %s", qPrintable(discovery_path()));
	return true;
}

void remove_discovery()
{
	QFile f(discovery_path());
	if (!f.open(QIODevice::ReadOnly)) return;
	const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
	f.close();
	if (o["pid"].toDouble() == (double)QCoreApplication::applicationPid()) f.remove();
}
} // namespace overlay
