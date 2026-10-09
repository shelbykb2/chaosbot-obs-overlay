#pragma once
#include <QByteArray>
#include <QString>

namespace overlay {
constexpr quint16 kPluginPort = 5260;

// Starts listening on 127.0.0.1:5260. Returns false when the port is taken.
bool start_http_server();
void stop_http_server();

// Latest mirror frame (JPEG), written by mirror.cpp, served at /mirror.jpg.
void set_mirror_frame(const QByteArray &jpeg);
// Milliseconds since a client last asked for a frame (huge when never).
qint64 ms_since_mirror_request();
} // namespace overlay
