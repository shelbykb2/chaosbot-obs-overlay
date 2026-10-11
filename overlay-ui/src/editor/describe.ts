import type { Box } from './geometry';
import type { El, PropValue } from './model';
import type { ElementType, Field } from './registry';

/* "Describe your overlay": the streamer writes what they want and the hosted model drafts a layout.
   The model only picks from what the registry offers (element types, their styles, colours and
   ranges), so it cannot invent CSS. Whatever it sends back is checked here against the registry:
   unknown types, keys and out-of-range values are dropped, never guessed. Nothing here touches
   the document; the caller opens the result as a draft layout. Runtime helpers come in as
   arguments, so the checks run under node's test runner without the editor. */

/** What validation needs from a registry entry. */
export type TypeSpec = Pick<ElementType, 'type' | 'label' | 'blurb' | 'single' | 'size' | 'min' | 'avoidByDefault' | 'editorOnly' | 'defaults' | 'fields'>;

/** Field kinds the model may set. Files, buttons and the goal clock stay the streamer's. */
const SETTABLE = new Set(['toggle', 'pick', 'swatches', 'slider', 'text']);

export const MAX_DESCRIPTION = 600;

function settable(fields: Field[]): Field[] {
  return fields.filter((f) => SETTABLE.has(f.kind));
}

function describeField(f: Field): string {
  switch (f.kind) {
    case 'toggle':
      return `${f.key}: true|false (${f.label})`;
    case 'pick':
      return `${f.key}: one of ${f.options.map((o) => JSON.stringify(o.value)).join(', ')} (${f.label})`;
    case 'swatches':
      return `${f.key}: one of ${f.options.map((o) => `${JSON.stringify(o.value)} ${o.name}`).join(', ')} (${f.label})`;
    case 'slider':
      return `${f.key}: number ${f.min} to ${f.max}, step ${f.step} (${f.label})`;
    case 'text':
      return `${f.key}: text up to ${f.max} characters (${f.label})`;
    default:
      return '';
  }
}

/** The element library as the model sees it. */
export function catalogue(types: TypeSpec[]): string {
  return types
    .filter((t) => !t.editorOnly)
    .map((t) => {
      const head = `- ${t.type} (${t.label}): ${t.blurb} Default size ${t.size.w}x${t.size.h}, smallest ${t.min.w}x${t.min.h}.${t.single ? ' At most one.' : ''}`;
      const fields = settable(t.fields).map((f) => '    ' + describeField(f));
      return [head, ...fields].join('\n');
    })
    .join('\n');
}

export function systemPrompt(types: TypeSpec[]): string {
  return [
    'You design stream overlays for a 1920x1080 canvas. Origin is the top left; x, y, w, h are whole pixels.',
    'Use only these element types and only the listed props and values. Anything else is thrown away.',
    catalogue(types),
    '',
    'Rules:',
    '- Keep the middle of the screen clear for the game. Put widgets near the edges and corners.',
    '- When a game picture is attached, keep widgets off its HUD (health, ammo, minimap, scores).',
    '- Widgets must not overlap each other.',
    '- Pick one accent colour that fits the description and use it on every element that has one.',
    '- Use only the elements the streamer asked for, plus at most two that clearly help.',
    'Answer with JSON only, no prose and no code fences:',
    '{"name": "<short layout name>", "elements": [{"type": "...", "name": "<optional>", "x": 0, "y": 0, "w": 0, "h": 0, "props": {}}]}',
  ].join('\n');
}

/** The streamer's words, and for a change request the draft as it stands. */
export function userPrompt(description: string, game: string | null, current: El[] | null): string {
  const words = description.trim().slice(0, MAX_DESCRIPTION);
  const parts = [];
  if (game) parts.push(`Game: ${game}`);
  if (current) {
    const draft = current.map((e) => ({ type: e.type, name: e.name, x: e.rect.x, y: e.rect.y, w: e.rect.w, h: e.rect.h, props: e.props }));
    parts.push('The current draft:\n' + JSON.stringify({ elements: draft }));
    parts.push('Change it like this, keeping everything else: ' + words);
  } else {
    parts.push('The streamer wants: ' + words);
  }
  return parts.join('\n\n');
}

export interface Draft {
  name: string;
  elements: El[];
  /** Things the model sent that were thrown away, in plain words. */
  dropped: string[];
}

/** Pulls the JSON object out of the model's text: plain, fenced, or with words around it. */
export function parseAnswer(text: string): unknown {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function clean(v: string, max: number): string {
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** The value a field accepts, or undefined when the model's value does not fit. */
export function fieldValue(f: Field, v: unknown): PropValue | undefined {
  switch (f.kind) {
    case 'toggle':
      return typeof v === 'boolean' ? v : undefined;
    case 'pick':
      return typeof v === 'string' && f.options.some((o) => o.value === v) ? v : undefined;
    case 'swatches':
      return typeof v === 'string' && f.options.some((o) => o.value.toLowerCase() === v.toLowerCase())
        ? f.options.find((o) => o.value.toLowerCase() === v.toLowerCase())!.value
        : undefined;
    case 'slider': {
      const n = num(v);
      if (n === null) return undefined;
      const stepped = f.min + Math.round((n - f.min) / f.step) * f.step;
      return Math.min(f.max, Math.max(f.min, Number(stepped.toFixed(6))));
    }
    case 'text':
      return typeof v === 'string' ? clean(v, f.max) : undefined;
    default:
      return undefined;
  }
}

export interface Deps {
  clampBox: (r: Box, minW: number, minH: number) => Box;
  newId: (type: string) => string;
  maxElements: number;
  maxName: number;
}

/** Checks the model's answer against the registry and builds the draft's elements. */
export function validateDraft(raw: unknown, types: TypeSpec[], deps: Deps): Draft | null {
  const { clampBox, maxElements: MAX, maxName } = deps;
  const o = raw as { name?: unknown; elements?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.elements)) return null;
  const byType = new Map(types.filter((t) => !t.editorOnly).map((t) => [t.type, t]));
  const dropped: string[] = [];
  const elements: El[] = [];
  const names = new Set<string>();

  for (const item of o.elements as unknown[]) {
    const e = item as { type?: unknown; name?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown; props?: unknown } | null;
    if (!e || typeof e !== 'object') continue;
    const T = typeof e.type === 'string' ? byType.get(e.type) : undefined;
    if (!T) {
      dropped.push(`an element of a kind the editor does not have (${clean(String(e.type ?? ''), 24) || 'no kind'})`);
      continue;
    }
    if (elements.length >= MAX) {
      dropped.push(`elements past the limit of ${MAX}`);
      break;
    }
    if (T.single && elements.some((x) => x.type === T.type)) {
      dropped.push(`a second ${T.label.toLowerCase()}`);
      continue;
    }
    const x = num(e.x), y = num(e.y), w = num(e.w), h = num(e.h);
    const rect = clampBox(
      { x: x ?? 960 - T.size.w / 2, y: y ?? 540 - T.size.h / 2, w: w ?? T.size.w, h: h ?? T.size.h },
      T.min.w,
      T.min.h,
    );

    const props: Record<string, PropValue> = { ...T.defaults };
    const given = e.props && typeof e.props === 'object' ? (e.props as Record<string, unknown>) : {};
    const fields = new Map(settable(T.fields).map((f) => [f.key, f]));
    for (const [k, v] of Object.entries(given)) {
      const f = fields.get(k);
      const ok = f ? fieldValue(f, v) : undefined;
      if (ok === undefined) dropped.push(`${T.label}: ${clean(k, 24)}`);
      else props[k] = ok;
    }

    let name = typeof e.name === 'string' ? clean(e.name, maxName) : '';
    if (!name || T.single) name = T.label;
    for (let i = 2; names.has(name); i++) name = `${T.label} ${i}`;
    names.add(name);

    elements.push({
      id: T.type === 'spotify' ? 'spotify' : deps.newId(T.type),
      type: T.type,
      name,
      rect,
      hidden: false,
      locked: false,
      avoid: T.avoidByDefault,
      props,
    });
  }

  const name = typeof o.name === 'string' ? clean(o.name, maxName) : '';
  return { name: name || 'Described layout', elements, dropped };
}
