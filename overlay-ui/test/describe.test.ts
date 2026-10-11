// "Describe your overlay" (src/editor/describe.ts): the model's draft is checked against the registry,
// so anything it invents is dropped, never guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogue, parseAnswer, userPrompt, validateDraft, type TypeSpec } from '../src/editor/describe.ts';
import { clampBox } from '../src/editor/geometry.ts';

let n = 0;
const deps = { clampBox, newId: (t: string) => `${t}-${++n}`, maxElements: 4, maxName: 60 };

const TYPES: TypeSpec[] = [
  {
    type: 'chat',
    label: 'Chat',
    blurb: 'Your Twitch chat.',
    size: { w: 420, h: 520 },
    min: { w: 200, h: 120 },
    avoidByDefault: true,
    defaults: { style: 'bubbles', accent: '#a970ff', textSize: 22, badges: true, title: '' },
    fields: [
      { kind: 'pick', key: 'style', label: 'Style', options: [{ value: 'bubbles', label: 'Bubbles' }, { value: 'plain', label: 'Plain' }] },
      { kind: 'swatches', key: 'accent', label: 'Accent', options: [{ value: '#A970FF', name: 'Purple' }, { value: '#ff5f5f', name: 'Red' }] },
      { kind: 'slider', key: 'textSize', label: 'Text size', min: 14, max: 40, step: 2 },
      { kind: 'toggle', key: 'badges', label: 'Badges' },
      { kind: 'text', key: 'title', label: 'Title', max: 10 },
      { kind: 'image', key: 'image', label: 'Picture' },
    ],
  },
  {
    type: 'spotify',
    label: 'Spotify card',
    blurb: 'Now playing.',
    single: true,
    size: { w: 505, h: 109 },
    min: { w: 300, h: 80 },
    avoidByDefault: true,
    defaults: {},
    fields: [],
  },
  {
    type: 'nogo',
    label: 'No-go zone',
    blurb: 'Chaos keeps out.',
    editorOnly: true,
    size: { w: 300, h: 200 },
    min: { w: 8, h: 8 },
    avoidByDefault: true,
    defaults: {},
    fields: [],
  },
];

test('the catalogue lists settable fields and leaves out files and editor-only types', () => {
  const c = catalogue(TYPES);
  assert.match(c, /- chat \(Chat\)/);
  assert.match(c, /style: one of "bubbles", "plain"/);
  assert.match(c, /textSize: number 14 to 40, step 2/);
  assert.doesNotMatch(c, /image/);
  assert.doesNotMatch(c, /nogo/);
});

test('answers are found in plain, fenced or chatty text', () => {
  assert.deepEqual(parseAnswer('{"a":1}'), { a: 1 });
  assert.deepEqual(parseAnswer('Sure!\n```json\n{"a":2}\n```'), { a: 2 });
  assert.equal(parseAnswer('no json here'), null);
  assert.equal(parseAnswer('{broken'), null);
});

test('good values pass, bad ones fall back to the defaults and are reported', () => {
  const d = validateDraft(
    {
      name: 'Cozy purple',
      elements: [
        {
          type: 'chat',
          x: 20, y: 540, w: 400, h: 500,
          props: { style: 'neon', accent: '#a970ff', textSize: 27, badges: 'yes', title: 'Chat\u0007 with me today', image: 'x.png', css: 'body{}' },
        },
      ],
    },
    TYPES,
    deps,
  )!;
  assert.equal(d.name, 'Cozy purple');
  const p = d.elements[0].props;
  assert.equal(p.style, 'bubbles');
  assert.equal(p.accent, '#A970FF');
  assert.equal(p.textSize, 28);
  assert.equal(p.badges, true);
  assert.equal(p.title, 'Chat  with');
  assert.equal(p.image, undefined);
  assert.equal(p.css, undefined);
  assert.deepEqual(d.dropped.sort(), ['Chat: badges', 'Chat: css', 'Chat: image', 'Chat: style'].sort());
});

test('rects are kept on the canvas and at least the smallest size', () => {
  const d = validateDraft({ elements: [{ type: 'chat', x: 1800, y: -50, w: 50, h: 5000 }] }, TYPES, deps)!;
  assert.deepEqual(d.elements[0].rect, { x: 1720, y: 0, w: 200, h: 1080 });
  const centred = validateDraft({ elements: [{ type: 'chat' }] }, TYPES, deps)!;
  assert.deepEqual(centred.elements[0].rect, { x: 750, y: 280, w: 420, h: 520 });
});

test('unknown kinds, editor-only kinds, a second single element and the overflow are dropped', () => {
  const d = validateDraft(
    {
      elements: [
        { type: 'fireworks' },
        { type: 'nogo' },
        { type: 'spotify' },
        { type: 'spotify' },
        { type: 'chat' },
        { type: 'chat' },
        { type: 'chat' },
        { type: 'chat' },
      ],
    },
    TYPES,
    deps,
  )!;
  assert.deepEqual(d.elements.map((e) => e.type), ['spotify', 'chat', 'chat', 'chat']);
  assert.equal(d.elements[0].id, 'spotify');
  assert.deepEqual(d.elements.slice(1).map((e) => e.name), ['Chat', 'Chat 2', 'Chat 3']);
  assert.equal(d.elements[1].avoid, true);
  assert.equal(d.dropped.length, 4);
  assert.equal(d.name, 'Described layout');
});

test('nonsense is refused outright', () => {
  assert.equal(validateDraft(null, TYPES, deps), null);
  assert.equal(validateDraft({ elements: 'chat' }, TYPES, deps), null);
});

test('a change request carries the current draft', () => {
  const d = validateDraft({ elements: [{ type: 'chat', x: 0, y: 0, w: 400, h: 400 }] }, TYPES, deps)!;
  const u = userPrompt('make chat smaller', 'THE FINALS', d.elements);
  assert.match(u, /Game: THE FINALS/);
  assert.match(u, /"type":"chat"/);
  assert.match(u, /Change it like this, keeping everything else: make chat smaller/);
  assert.match(userPrompt('x'.repeat(900), null, null), /^The streamer wants: x{600}$/);
});
