// Layout selection and cross-fade layers for /scene/ pages (src/scene/layers.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LEAVING, dropLayer, feedsOf, nextLayers, pageSceneId, targetScene, type Layer } from '../src/scene/layers.ts';

test('the page id comes from /scene/<id> only', () => {
  assert.equal(pageSceneId('/scene/gameplay'), 'gameplay');
  assert.equal(pageSceneId('/scene/live/'), 'live');
  assert.equal(pageSceneId('/scene/'), null);
  assert.equal(pageSceneId('/scene/a/b'), null);
  assert.equal(pageSceneId('/spotify/'), null);
  assert.equal(pageSceneId('/scene/%E0%A4%A'), null);
});

test('live follows the active layout, any other id stays put', () => {
  assert.equal(targetScene('live', 'brb'), 'brb');
  assert.equal(targetScene('gameplay', 'brb'), 'gameplay');
  assert.equal(targetScene('live', null), null);
});

test('the first layout appears without a fade, a switch fades', () => {
  let ls: Layer[] = nextLayers([], 'gameplay', 1);
  assert.deepEqual(ls, [{ key: 1, sceneId: 'gameplay', fadeIn: false, leaving: false }]);
  assert.equal(nextLayers(ls, 'gameplay', 2), ls, 'same layout changes nothing');
  ls = nextLayers(ls, 'brb', 2);
  assert.deepEqual(ls, [
    { key: 1, sceneId: 'gameplay', fadeIn: false, leaving: true },
    { key: 2, sceneId: 'brb', fadeIn: true, leaving: false },
  ]);
  ls = dropLayer(ls, 1);
  assert.deepEqual(
    ls.map((l) => l.key),
    [2],
  );
  assert.deepEqual(dropLayer(ls, 2), ls, 'the layer on screen is never dropped');
});

test('a fast run of switches keeps only the newest leaving layers', () => {
  let ls: Layer[] = [];
  ['a', 'b', 'c', 'd', 'e'].forEach((id, i) => (ls = nextLayers(ls, id, i + 1)));
  assert.equal(ls.filter((l) => l.leaving).length, MAX_LEAVING);
  assert.equal(ls.at(-1)!.sceneId, 'e');
});

test('a layout that disappears leaves nothing on screen', () => {
  const ls = nextLayers(nextLayers([], 'a', 1), null, 2);
  assert.deepEqual(
    ls.map((l) => [l.sceneId, l.leaving]),
    [['a', true]],
  );
});

test('feeds are collected once, sorted', () => {
  const map: Record<string, string[]> = { spotify: ['spotify'], chat: ['chat', 'spotify'] };
  assert.deepEqual(feedsOf(['spotify', 'text', 'spotify', 'chat'], (t) => map[t]), ['chat', 'spotify']);
});
