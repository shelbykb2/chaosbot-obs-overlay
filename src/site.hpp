#pragma once
// The site folder (where the overlay pages live) and safe path handling for it.
#include <QByteArray>
#include <QString>

namespace overlay {
// Creates the folder if needed and remembers its canonical path.
void site_init(const QString &dir);
const QString &site_dir();

// Turns the raw path of a request (before any "?") into a relative path inside the site.
// Decodes percent escapes once. Rejects "..", backslashes, colons, control characters, NUL,
// a leading "//", Windows device names and names ending in a dot or space.
// An empty result is the site root. Returns false when the path is not acceptable.
bool clean_request_path(const QByteArray &raw_path, QString *rel);

// Existing file to read (a folder resolves to its index.html). The real path must stay
// inside the site folder. Returns false (and an empty path) otherwise.
bool resolve_read(const QString &rel, QString *file);

// Target file for a write or delete. The file need not exist yet, but the nearest existing
// parent folder must really be inside the site folder (so a link cannot lead outside).
bool resolve_write(const QString &rel, QString *file);

// Only these top-level places may be written or deleted by the sync routes.
bool write_allowed(const QString &rel);
} // namespace overlay
