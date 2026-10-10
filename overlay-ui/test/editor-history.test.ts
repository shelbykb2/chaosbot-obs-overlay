// Undo history for the overlay editor (src/editor/history.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COALESCE_MS, History, MAX_STEPS } from '../src/editor/history.ts';

test('undo and redo walk the snapshots', () => {
  const h = new History<number>();
  h.record(1, 0);
  h.record(2, 1000);
  assert.equal(h.undo(3), 2);
  assert.equal(h.undo(2), 1);
  assert.equal(h.undo(1), null);
  assert.equal(h.redo(1), 2);
  assert.equal(h.redo(2), 3);
  assert.equal(h.redo(3), null);
});

test('changes with one key close together make one step', () => {
  const h = new History<string>();
  h.record('a', 0, 'name');
  h.record('ab', 100, 'name');
  h.record('abc', 100 + COALESCE_MS - 1, 'name');
  assert.equal(h.past.length, 1);
  h.record('abcd', 100 + 3 * COALESCE_MS, 'name');
  assert.equal(h.past.length, 2);
});

test('cut ends a coalescing run', () => {
  const h = new History<number>();
  h.record(1, 0, 'k');
  h.cut();
  h.record(2, 10, 'k');
  assert.equal(h.past.length, 2);
});

test('a new change drops the redo steps', () => {
  const h = new History<number>();
  h.record(1, 0);
  h.undo(2);
  h.record(1, 5000);
  assert.equal(h.future.length, 0);
});

test('history keeps the last MAX_STEPS steps and reset clears it', () => {
  const h = new History<number>();
  for (let i = 0; i < MAX_STEPS + 20; i++) h.record(i, i * 1000);
  assert.equal(h.past.length, MAX_STEPS);
  assert.equal(h.past[0], 20);
  h.reset();
  assert.equal(h.past.length + h.future.length, 0);
});
