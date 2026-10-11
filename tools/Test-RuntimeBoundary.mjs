// Runs the real loopback host without OBS, account credentials, or saved user layouts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

const probe = createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const root = await mkdtemp(join(tmpdir(), 'overlay-boundary-'));
const base = `http://127.0.0.1:${port}`;
const child = spawn('dotnet', [fileURLToPath(new URL('../runtime/bin/Release/net10.0/ChaosBot.Overlay.Runtime.dll', import.meta.url)),
  '--site', join(root, 'site'), '--pages', fileURLToPath(new URL('../data/site/', import.meta.url)),
  '--port', String(port), '--token', randomBytes(24).toString('hex'), '--parent', String(process.pid)],
  { windowsHide: true, stdio: 'ignore' });
const closed = new Promise((resolve) => child.once('close', resolve));
let startError;
child.once('error', (error) => { startError = error; });

async function upgrade(origin) {
  return new Promise((resolve, reject) => {
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64') };
    if (origin !== undefined) headers.Origin = origin;
    const req = request(base + '/overlay/hub', { headers });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('WebSocket upgrade timed out')));
    req.end();
  });
}

try {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (startError) throw startError;
    if (child.exitCode !== null) throw new Error('Test runtime exited before becoming ready');
    try { ready = (await fetch(base + '/health')).ok; } catch { }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Test runtime did not start');
  for (const origin of [undefined, 'http://127.0.0.1:5260', 'http://localhost:5260', base])
    assert.equal(await upgrade(origin), 101, `Local/native origin rejected: ${origin}`);
  for (const origin of ['https://attacker.example', 'null', 'http://127.0.0.1:9999', 'http://127.0.0.1:5260.attacker.example']) {
    assert.equal(await upgrade(origin), 403, `Foreign WebSocket origin accepted: ${origin}`);
    assert.equal((await fetch(base + '/overlay/hub/negotiate?negotiateVersion=1', { method: 'POST', headers: { Origin: origin } })).status, 403);
  }
  const allowed = await fetch(base + '/overlay/hub/negotiate?negotiateVersion=1', { method: 'POST', headers: { Origin: 'http://127.0.0.1:5260' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5260');
  console.log('Real HTTP/SignalR origin boundary passed: local upgrades accepted, foreign upgrades and negotiation rejected.');
} finally {
  if (child.exitCode === null) child.kill();
  await closed;
  assert.equal(resolve(dirname(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('overlay-boundary-'));
  await rm(root, { recursive: true, force: true });
}
