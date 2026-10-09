#pragma once
// The per-start secret and the discovery file ChaosBot reads to find this plugin.
#include <QByteArray>

namespace overlay {
// 64 hex characters from the system random generator, made once per start.
const QByteArray &session_token();
// Compares in constant time.
bool token_matches(const QByteArray &presented);

// Writes plugin.json (atomically) with the port, token, OBS process id and plugin version.
bool write_discovery(quint16 port);
// Deletes plugin.json, but only when it holds this process id.
void remove_discovery();
} // namespace overlay
