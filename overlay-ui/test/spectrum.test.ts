// The cover bump (src/shared/spectrum.ts). Run with `npm test`. The owner saw the bump drift out of
// time with the music: it followed a beat flag that came late and stopped firing under a steady bass
// line. The bump now follows the punch byte, so these check that it does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, Spectrum } from '../src/shared/spectrum.ts';

function frame(punch: number, beat = false, bytes = BANDS + 3) {
  const f = new Uint8Array(bytes);
  f[BANDS] = beat ? 1 : 0;
  if (bytes > BANDS + 2) f[BANDS + 2] = Math.round(punch * 255);
  return f;
}

test('a hard hit bumps at once, without waiting for the beat flag', () => {
  const s = new Spectrum();
  s.push(frame(0.9));
  assert.ok(s.kick > 0.95, `kick ${s.kick}`);
  assert.equal(s.beats, 0);
});

test('the bass line moving under the floor does not bump', () => {
  const s = new Spectrum();
  s.push(frame(0.08));
  assert.equal(s.kick, 0);
});

test('a softer hit bumps less than a hard one', () => {
  const soft = new Spectrum();
  const hard = new Spectrum();
  soft.push(frame(0.3));
  hard.push(frame(0.6));
  assert.ok(soft.kick > 0 && soft.kick < hard.kick, `soft ${soft.kick}, hard ${hard.kick}`);
});

test('the bump decays between hits', () => {
  const s = new Spectrum();
  s.push(frame(0.9));
  s.step(performance.now() + 200, 0.2);
  assert.ok(s.kick < 0.3, `kick ${s.kick}`);
});

test('the beat flag still counts for the sparks', () => {
  const s = new Spectrum();
  s.push(frame(0.9, true));
  assert.equal(s.beats, 1);
});

test('an older 34-byte frame bumps on the beat flag', () => {
  const s = new Spectrum();
  s.push(frame(0, false, BANDS + 2));
  assert.equal(s.kick, 0);
  s.push(frame(0, true, BANDS + 2));
  assert.equal(s.kick, 1);
});
