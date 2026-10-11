// The command feed's data (src/shared/commandFeed.ts): it is drawn on stream, so anything odd from
// the hub is dropped rather than shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEmpty, readFeed, sampleFeed, visible } from '../src/shared/commandFeed.ts';

test('a good body reads through', () => {
  const f = readFeed({
    now: { id: 'a', user: 'pixelpanda', text: 'jump', at: '2026-10-08T00:00:00Z' },
    next: [{ id: 'b', user: 'moon', text: 'crouch' }],
    recent: [{ id: 'c', user: 'fox', text: 'reload', outcome: 'unsure' }],
  });
  assert.equal(f.now?.user, 'pixelpanda');
  assert.equal(f.next.length, 1);
  assert.equal(f.recent[0].outcome, 'unsure');
});

test('rows with no user, no text or an unknown outcome are dropped', () => {
  const f = readFeed({
    now: { id: 'a', user: '', text: 'jump' },
    next: [{ id: 'b', user: 'moon' }, 'nope', null],
    recent: [{ id: 'c', user: 'fox', text: 'reload', outcome: 'exploded' }],
  });
  assert.equal(f.now, null);
  assert.deepEqual(f.next, []);
  assert.deepEqual(f.recent, []);
  assert.ok(isEmpty(f));
  assert.ok(isEmpty(readFeed('garbage')));
});

test('control characters become spaces and long text is cut', () => {
  const f = readFeed({ now: { id: 'a', user: 'x\u0000y', text: 'line one\nline two' + 'z'.repeat(300) } });
  assert.equal(f.now?.user, 'x y');
  assert.ok(f.now!.text.startsWith('line one line two'));
  assert.ok(f.now!.text.length <= 101);
});

test('the element shows only as many rows as asked', () => {
  const f = visible(sampleFeed(0), 1, 0);
  assert.equal(f.next.length, 1);
  assert.equal(f.recent.length, 0);
  assert.ok(f.now);
});

test('the sample moves forward: what was next runs, and what ran becomes a result', () => {
  const a = sampleFeed(0);
  const b = sampleFeed(1);
  assert.equal(b.now?.id, a.next[0].id);
  assert.equal(b.recent[0].id, a.now?.id);
});
