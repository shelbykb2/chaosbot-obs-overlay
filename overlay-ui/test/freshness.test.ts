// The stale-page check (src/shared/freshness.ts). The owner turned the cover shine off and OBS kept
// showing it: the OBS page still ran the code from before the setting existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, moduleScripts } from '../src/shared/freshness.ts';

const page = (hash: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/spotify/assets/index-${hash}.js"></script>` +
  `<link rel="stylesheet" href="/spotify/assets/index-${hash}.css"></head><body></body></html>`;

test('reads only the module scripts', () => {
  const html = page('abc') + '<script src="/chaos/signalr.min.js?v=8.0.0"></script>';
  assert.deepEqual(moduleScripts(html), ['/spotify/assets/index-abc.js']);
});

test('a new build is stale, the same build is not', () => {
  const running = moduleScripts(page('abc'));
  assert.equal(isStale(running, moduleScripts(page('abc'))), false);
  assert.equal(isStale(running, moduleScripts(page('def'))), true);
});

test('an error page or an empty answer never reloads', () => {
  const running = moduleScripts(page('abc'));
  assert.equal(isStale(running, moduleScripts('<h1>502 Bad Gateway</h1>')), false);
  assert.equal(isStale(running, []), false);
  assert.equal(isStale([], moduleScripts(page('def'))), false);
});
