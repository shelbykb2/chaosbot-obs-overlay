// Alerts and goals (src/shared/alerts.ts): drawn on stream, so anything odd from the hub is dropped,
// and the streamer's switches and minimums decide what shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fraction, headline, readAlert, readGoal, sampleAlert, settingFor, wanted } from '../src/shared/alerts.ts';

test('a good event reads through, and odd ones are dropped', () => {
  const a = readAlert({ id: 'e1', kind: 'bits', name: 'NovaKade', amount: 500, message: 'hi\u0007 there', test: false });
  assert.deepEqual(a, { id: 'e1', kind: 'bits', name: 'NovaKade', amount: 500, message: 'hi  there', test: false });
  assert.equal(readAlert({ kind: 'hug', name: 'x' }), null);
  assert.equal(readAlert({ kind: 'follow', name: '' }), null);
  assert.equal(readAlert(null), null);
  assert.equal(readAlert({ kind: 'raid', name: 'fox', amount: -3 })!.amount, 0);
  assert.equal(readAlert({ kind: 'follow', name: 'x'.repeat(80) })!.name.length, 25);
});

test('templates fill in the name and amount, and a blank one falls back', () => {
  const a = readAlert({ id: '1', kind: 'gift', name: 'sir_toasty', amount: 1500 })!;
  assert.equal(headline(a, '{name} dropped {amount} gifts'), 'sir_toasty dropped 1,500 gifts');
  assert.equal(headline(a, '   '), 'sir_toasty gifted 1,500 subs!');
  assert.equal(headline(a, undefined), 'sir_toasty gifted 1,500 subs!');
});

test('switches and minimums decide what shows', () => {
  const bits = readAlert({ id: '1', kind: 'bits', name: 'a', amount: 50 })!;
  const raid = readAlert({ id: '2', kind: 'raid', name: 'b', amount: 3 })!;
  const resub = readAlert({ id: '3', kind: 'resub', name: 'c', amount: 6 })!;
  assert.equal(wanted(bits, { bits: true, minBits: 100 }), false);
  assert.equal(wanted(bits, { bits: true, minBits: 50 }), true);
  assert.equal(wanted(raid, { raid: true, minRaid: 5 }), false);
  assert.equal(wanted(resub, { sub: false }), false, 'a resub follows the sub switch');
  assert.equal(settingFor('gift'), 'sub');
});

test('goals read and the fill stays between empty and full', () => {
  assert.deepEqual(readGoal({ id: 'g1', current: 12.7 }), { id: 'g1', current: 12 });
  assert.equal(readGoal({ id: 'g1', current: -1 }), null);
  assert.equal(readGoal({ current: 3 }), null);
  assert.equal(fraction(5, 10), 0.5);
  assert.equal(fraction(15, 10), 1);
  assert.equal(fraction(5, 0), 0);
});

test('the editor samples cover every kind', () => {
  const kinds = new Set(Array.from({ length: 6 }, (_, i) => sampleAlert(i).kind));
  assert.equal(kinds.size, 6);
});
