// The chat box's data (src/shared/chat.ts): chat is drawn on stream, so a deleted message or a
// banned viewer must go at once, and nothing odd from the hub is shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addLine, applyClear, hiddenUsers, MAX_LINES, nameColor, readHistory, readLine, sampleLine, segments, shown, type ChatLine } from '../src/shared/chat.ts';

const line = (id: string, user = 'viewer', text = 'hello'): ChatLine => readLine({ id, user, name: user, text })!;

test('a line reads through with only the badges ChaosBot knows', () => {
  const l = readLine({ id: 'a', user: 'MoonByte', name: 'MoonByte', color: '#112233', badges: ['subscriber', 'turbo', 'broadcaster'], text: 'hi' })!;
  assert.equal(l.user, 'moonbyte');
  assert.deepEqual(l.badges, ['broadcaster', 'subscriber']);
  assert.equal(readLine({ id: 'b', user: 'x', text: '   ' }), null);
  assert.equal(readLine({ id: 'c', user: 'x', text: 'hi', color: 'red' })!.color, '');
});

test('emotes cut the text, and bad or overlapping ranges are dropped', () => {
  const l = readLine({
    id: 'a', user: 'x', text: '😀 Kappa hi Kappa',
    emotes: [{ id: '25', start: 3, end: 7 }, { id: '25', start: 5, end: 9 }, { id: '../x', start: 12, end: 16 }, { id: '25', start: 12, end: 99 }],
  })!;
  assert.deepEqual(segments(l), [{ text: '😀 ' }, { emote: '25', alt: 'Kappa' }, { text: ' hi Kappa' }]);
});

test('a deleted message, a banned viewer and a cleared chat all go', () => {
  const ls = [line('1', 'a'), line('2', 'b'), line('3', 'a')];
  assert.deepEqual(applyClear(ls, { id: '2' }).map((l) => l.id), ['1', '3']);
  assert.deepEqual(applyClear(ls, { user: 'A' }).map((l) => l.id), ['2']);
  assert.deepEqual(applyClear(ls, { all: true }), []);
  assert.equal(applyClear(ls, {}), ls);
});

test('the box keeps the newest lines and ignores a repeat', () => {
  let ls: ChatLine[] = [];
  for (let i = 0; i < MAX_LINES + 5; i++) ls = addLine(ls, line(String(i)));
  assert.equal(ls.length, MAX_LINES);
  assert.equal(ls[ls.length - 1].id, String(MAX_LINES + 4));
  assert.equal(addLine(ls, line(String(MAX_LINES + 4))), ls);
  assert.equal(readHistory({ lines: [{ id: 'a', user: 'x', text: 'hi' }, 'bad'] }).length, 1);
});

test('commands and listed viewers are hidden', () => {
  const ls = [line('1', 'nightbot'), line('2', 'v', '!chaos jump'), line('3', 'v', 'gg')];
  assert.deepEqual(shown(ls, { hideCommands: true, hide: hiddenUsers('@NightBot, streamelements') }).map((l) => l.id), ['3']);
  assert.equal(shown(ls, { hideCommands: false, hide: new Set() }).length, 3);
});

test('a dark name colour is lifted so it reads on a dark background', () => {
  assert.notEqual(nameColor({ color: '#000080', user: 'x' }), '#000080');
  assert.equal(nameColor({ color: '#FF7F50', user: 'x' }).toLowerCase(), '#ff7f50');
  assert.match(nameColor({ color: '', user: 'someone' }), /^#[0-9a-f]{6}$/);
});

test('every sample emote covers a whole word', () => {
  for (let n = 0; n < 8; n++) {
    for (const s of segments(sampleLine(n))) if ('emote' in s) assert.match(s.alt, /^\S+$/);
  }
});
