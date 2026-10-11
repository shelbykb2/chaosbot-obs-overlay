import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../pages/source.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
function rig() {
  let online = true, ready = false, tick = () => {};
  const frames: any[] = [];
  runInNewContext(source, {
    fetch: async (path: string) => path === '/api/status' ? { json: async () => ({ companion: online }) } : { ok: ready },
    setInterval: (fn: () => void) => { tick = fn; },
    document: {
      createElement: () => ({ remove() { frames.splice(frames.indexOf(this), 1); } }),
      body: { append: (frame: any) => frames.push(frame) },
    },
  });
  return { frames, setOnline: (value: boolean) => online = value, setReady: (value: boolean) => ready = value, tick: () => tick() };
}

test('a running bot without a synced companion page never covers the standalone layout', async () => {
  const r = rig(); await flush();
  assert.equal(r.frames.length, 0);
  r.tick(); await flush();
  assert.equal(r.frames.length, 0);
});

test('a later synced companion appears once and disappears when the bot disconnects', async () => {
  const r = rig(); await flush();
  r.setReady(true); r.tick(); await flush();
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].src, '/companion/');
  r.tick(); await flush();
  assert.equal(r.frames.length, 1);
  r.setOnline(false); r.tick(); await flush();
  assert.equal(r.frames.length, 0);
});
