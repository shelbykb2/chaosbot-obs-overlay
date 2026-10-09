#pragma once
// The /sync/... routes ChaosBot uses to copy the overlay into the site folder.
#include <QByteArray>

namespace overlay {
struct SyncReply {
	int code = 200;
	QByteArray type = "application/json";
	QByteArray body;
};

// method: GET, PUT or DELETE. raw_path starts with "/sync/". auth is the Authorization header.
// Checks the token first (401), then the path (400), then the allowed folders (403).
SyncReply handle_sync(const QByteArray &method, const QByteArray &raw_path, const QByteArray &auth,
		      const QByteArray &body);

// Milliseconds since an authorized sync request arrived (huge when never).
qint64 ms_since_last_sync();
} // namespace overlay
