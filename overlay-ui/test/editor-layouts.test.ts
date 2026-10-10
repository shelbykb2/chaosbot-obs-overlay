// Layouts in the overlay editor's document (src/editor/model.ts): what puts each one live, and which
// one the canvas shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDoc, sceneById } from '../src/editor/model.ts';

const doc = (scenes: unknown[], activeSceneId = 'a') => readDoc({ schemaVersion: 1, activeSceneId, scenes })!;

test('a layout from an older ChaosBot has no triggers, and still loads', () => {
  const d = doc([{ id: 'a', name: 'Gameplay', elements: [] }]);
  assert.deepEqual(d.scenes[0].showFor, []);
});

test('triggers keep games and categories and drop anything else', () => {
  const d = doc([
    {
      id: 'a',
      name: 'A',
      elements: [],
      showFor: [
        { kind: 'game', value: 'wardogs', label: 'Wardogs' },
        { kind: 'category', value: '509658', label: 'Just Chatting' },
        { kind: 'category', value: '26936' },
        { kind: 'channel', value: 'x', label: 'X' },
        { kind: 'game', value: '', label: 'Empty' },
        { kind: 'game', value: 7 },
        null,
      ],
    },
  ]);
  assert.deepEqual(d.scenes[0].showFor, [
    { kind: 'game', value: 'wardogs', label: 'Wardogs' },
    { kind: 'category', value: '509658', label: 'Just Chatting' },
    { kind: 'category', value: '26936', label: '26936' },
  ]);
});

test('the canvas shows the layout being edited, or the live one when that is gone', () => {
  const d = doc(
    [
      { id: 'a', name: 'A', elements: [] },
      { id: 'b', name: 'B', elements: [] },
    ],
    'b',
  );
  assert.equal(sceneById(d, 'a').id, 'a');
  assert.equal(sceneById(d, 'deleted').id, 'b');
  assert.equal(sceneById(d, null).id, 'b');
});
