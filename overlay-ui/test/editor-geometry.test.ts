// Canvas maths for the overlay editor (src/editor/geometry.ts): what a drag or a resize does to a
// box, and where it snaps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampBox, dragBox, moveDelta, resizeBox, snapTargets } from '../src/editor/geometry.ts';

test('clampBox keeps whole pixels, the minimum size and the canvas', () => {
  assert.deepEqual(clampBox({ x: -10.4, y: 1070, w: 3, h: 40.6 }, 8, 8), { x: 0, y: 1039, w: 8, h: 41 });
  assert.deepEqual(clampBox({ x: 1900, y: 0, w: 5000, h: 10 }, 8, 8), { x: 0, y: 0, w: 1920, h: 10 });
});

test('a move snaps an edge to the canvas centre and reports the guide', () => {
  const b0 = { x: 100, y: 100, w: 200, h: 100 };
  const r = moveDelta(b0, 755, 0, snapTargets([]), 7);
  // The left edge lands at 855; the centre (955) is 5 from 960.
  assert.equal(r.dx, 760);
  assert.deepEqual(r.guides, [{ axis: 'x', at: 960 }]);
});

test('a move without snapping is only kept on the canvas', () => {
  const r = moveDelta({ x: 100, y: 100, w: 200, h: 100 }, -500, 2000, null, 7);
  assert.deepEqual(r, { dx: -100, dy: 880, guides: [] });
});

test('a move snaps to another element edge', () => {
  const other = { x: 600, y: 300, w: 100, h: 100 };
  const r = moveDelta({ x: 0, y: 0, w: 100, h: 50 }, 497, 0, snapTargets([other]), 7);
  assert.equal(r.dx, 500); // right edge on the other's left edge
});

test('a resize from the corner holds the opposite corner and keeps the minimum', () => {
  const r0 = { x: 100, y: 100, w: 200, h: 100 };
  const { rect } = resizeBox(r0, 'nw', 500, 500, { targets: null, thr: 7, aspect: null, minW: 77, minH: 44 });
  assert.deepEqual(rect, { x: 223, y: 156, w: 77, h: 44 });
});

test('a resize with a locked aspect keeps the shape and stays on the canvas', () => {
  const r0 = { x: 1600, y: 900, w: 200, h: 100 };
  const { rect, guides } = resizeBox(r0, 'se', 400, 0, { targets: snapTargets([]), thr: 7, aspect: 2, minW: 8, minH: 8 });
  assert.deepEqual(guides, []);
  assert.equal(rect.x, 1600);
  assert.equal(rect.y, 900);
  assert.equal(rect.w / rect.h, 2);
  assert.ok(rect.x + rect.w <= 1920 && rect.y + rect.h <= 1080);
});

test('a resized edge snaps', () => {
  const { rect, guides } = resizeBox({ x: 0, y: 0, w: 950, h: 100 }, 'e', 6, 0, {
    targets: snapTargets([]),
    thr: 7,
    aspect: null,
    minW: 8,
    minH: 8,
  });
  assert.equal(rect.w, 960);
  assert.deepEqual(guides, [{ axis: 'x', at: 960 }]);
});

test('dragBox works in any direction and stops at the canvas', () => {
  assert.deepEqual(dragBox({ x: 300, y: 200 }, { x: 100, y: -50 }), { x: 100, y: 0, w: 200, h: 200 });
  assert.deepEqual(dragBox({ x: 1900, y: 1000 }, { x: 2500, y: 1200 }), { x: 1900, y: 1000, w: 20, h: 80 });
});
