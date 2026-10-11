/* The overlay document, the same shape ChaosBot stores in overlay_scenes.json (OverlayScenesDoc
   in ChaosBot.Core, serialised camelCase). Rects are whole pixels on the 1920 x 1080 canvas.
   Array order is paint order: the last element is on top. */

export const CANVAS = { w: 1920, h: 1080 } as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PropValue = string | number | boolean;

export interface El {
  id: string;
  type: string;
  name: string;
  rect: Rect;
  hidden: boolean;
  locked: boolean;
  /** Chaos keeps out of this element's box. Always on for a no-go zone. */
  avoid: boolean;
  props: Record<string, PropValue>;
}

/** What puts a layout live: focusing a game ChaosBot knows, or a Twitch category on the stream. */
export interface Trigger {
  kind: 'game' | 'category';
  /** The game profile's name, or the Twitch category id. */
  value: string;
  /** What the editor shows. */
  label: string;
}

export interface Scene {
  id: string;
  name: string;
  elements: El[];
  showFor: Trigger[];
}

export interface Doc {
  schemaVersion: number;
  /** The layout that is live. ChaosBot owns it: switching games changes it, and so does Make live now. */
  activeSceneId: string;
  scenes: Scene[];
}

/** Limits ChaosBot enforces (OverlayScenesDoc). The editor keeps inside them so a save never trims. */
export const LIMITS = {
  maxElements: 64,
  maxName: 60,
  minSide: 8,
  maxScenes: 24,
  maxTriggers: 16,
} as const;

let n = 0;
export function newId(prefix = 'el'): string {
  n++;
  return `${prefix}_${Date.now().toString(36).slice(-5)}${n.toString(36)}`;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export function emptyDoc(): Doc {
  return { schemaVersion: 1, activeSceneId: 'gameplay', scenes: [{ id: 'gameplay', name: 'Gameplay', elements: [], showFor: [] }] };
}

export function activeScene(doc: Doc): Scene {
  return doc.scenes.find((s) => s.id === doc.activeSceneId) ?? doc.scenes[0];
}

/** The layout with this id, or the live one when it is gone. */
export function sceneById(doc: Doc, id: string | null): Scene {
  return (id && doc.scenes.find((s) => s.id === id)) || activeScene(doc);
}

function readTriggers(raw: unknown): Trigger[] {
  if (!Array.isArray(raw)) return [];
  const out: Trigger[] = [];
  for (const t of raw) {
    if (!t || (t.kind !== 'game' && t.kind !== 'category') || typeof t.value !== 'string' || !t.value) continue;
    out.push({ kind: t.kind, value: t.value, label: typeof t.label === 'string' && t.label ? t.label : t.value });
  }
  return out;
}

/** A document from ChaosBot, checked loosely: anything malformed is dropped, never thrown on. */
export function readDoc(raw: unknown): Doc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<Doc>;
  if (!Array.isArray(d.scenes) || d.scenes.length === 0) return null;
  const scenes: Scene[] = [];
  for (const s of d.scenes) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.elements)) continue;
    const elements: El[] = [];
    for (const e of s.elements) {
      if (!e || typeof e.id !== 'string' || typeof e.type !== 'string' || !e.rect) continue;
      elements.push({
        id: e.id,
        type: e.type,
        name: typeof e.name === 'string' ? e.name : e.type,
        rect: { x: +e.rect.x || 0, y: +e.rect.y || 0, w: +e.rect.w || LIMITS.minSide, h: +e.rect.h || LIMITS.minSide },
        hidden: !!e.hidden,
        locked: !!e.locked,
        avoid: !!e.avoid,
        props: e.props && typeof e.props === 'object' ? { ...e.props } : {},
      });
    }
    scenes.push({ id: s.id, name: typeof s.name === 'string' ? s.name : s.id, elements, showFor: readTriggers((s as { showFor?: unknown }).showFor) });
  }
  if (!scenes.length) return null;
  const active = typeof d.activeSceneId === 'string' && scenes.some((s) => s.id === d.activeSceneId) ? d.activeSceneId : scenes[0].id;
  return { schemaVersion: typeof d.schemaVersion === 'number' ? d.schemaVersion : 1, activeSceneId: active, scenes };
}
