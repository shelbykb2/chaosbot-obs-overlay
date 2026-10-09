#include "site.hpp"
#include <QDir>
#include <QFileInfo>
#include <QStringList>
#include <QUrl>
#include <cstring>

namespace overlay {
static QString g_dir;

#ifdef Q_OS_WIN
static const Qt::CaseSensitivity kCase = Qt::CaseInsensitive;
#else
static const Qt::CaseSensitivity kCase = Qt::CaseSensitive;
#endif

void site_init(const QString &dir)
{
	QDir().mkpath(dir);
	g_dir = QDir(dir).canonicalPath();
}

const QString &site_dir() { return g_dir; }

static bool inside_site(const QString &canonical)
{
	return canonical.compare(g_dir, kCase) == 0 || canonical.startsWith(g_dir + "/", kCase);
}

static bool reserved_name(const QString &segment)
{
	const QString base = segment.section('.', 0, 0).toLower();
	if (base == "con" || base == "prn" || base == "aux" || base == "nul") return true;
	if ((base.startsWith("com") || base.startsWith("lpt")) && base.size() == 4 && base[3] >= '0' && base[3] <= '9')
		return true;
	return false;
}

bool clean_request_path(const QByteArray &raw, QString *rel)
{
	if (raw.isEmpty() || raw[0] != '/' || raw.startsWith("//")) return false;
	const QString p = QUrl::fromPercentEncoding(raw);
	if (p.contains("..") || p.contains(QLatin1Char('\\')) || p.contains(QLatin1Char(':'))) return false;
	for (const QChar c : p)
		if (c.unicode() < 0x20 || c.unicode() == 0x7f) return false;
	if (p.startsWith("//")) return false;
	const QString r = p.mid(1);
	const QStringList segs = r.split('/');
	for (int i = 0; i < segs.size(); i++) {
		const QString &s = segs[i];
		const bool last = i == segs.size() - 1;
		if (s.isEmpty()) {
			if (last) continue; // trailing slash
			return false;       // "a//b"
		}
		if (s == "." || s.endsWith('.') || s.endsWith(' ') || reserved_name(s)) return false;
	}
	*rel = r;
	return true;
}

bool resolve_read(const QString &rel, QString *file)
{
	file->clear();
	if (g_dir.isEmpty()) return false;
	QString full = g_dir;
	if (!rel.isEmpty()) full += "/" + rel;
	QFileInfo fi(full);
	if (fi.isDir()) fi = QFileInfo(QDir(full).filePath("index.html"));
	if (!fi.isFile()) return false;
	const QString canonical = fi.canonicalFilePath();
	if (canonical.isEmpty() || !inside_site(canonical)) return false;
	*file = canonical;
	return true;
}

bool resolve_write(const QString &rel, QString *file)
{
	file->clear();
	if (g_dir.isEmpty() || rel.isEmpty() || rel.endsWith('/')) return false;
	const QString full = g_dir + "/" + rel;
	QFileInfo target(full);
	if (target.isDir()) return false;
	if (target.exists()) {
		const QString c = target.canonicalFilePath();
		if (c.isEmpty() || !inside_site(c)) return false;
	}
	QString parent = target.absolutePath();
	while (!QFileInfo(parent).isDir()) {
		const int slash = parent.lastIndexOf('/');
		if (slash <= 0) return false;
		parent = parent.left(slash);
	}
	const QString pc = QFileInfo(parent).canonicalFilePath();
	if (pc.isEmpty() || !inside_site(pc)) return false;
	*file = full;
	return true;
}

bool write_allowed(const QString &rel)
{
	if (rel == "index.html") return true;
	for (const char *top : {"chaos/", "scene/", "spotify/", "ui/", "overlay/"}) {
		if (rel.startsWith(QLatin1String(top))) return rel.size() > (qsizetype)strlen(top);
	}
	return false;
}
} // namespace overlay
