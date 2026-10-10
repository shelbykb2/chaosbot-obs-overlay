import { send } from './bridge';
import { clampBox, type Box } from './geometry';
import { clone, LIMITS, newId, type El, type PropValue, type Trigger } from './model';
import { REGISTRY, typeOf } from './registry';
import { commit, editEl, get, scene, sceneOf, select, set, toast, type Chaos } from './store';
import type { Urls } from './store';

/* Edits the toolbar, the list, the properties panel and the keys share. Each is one undo step. */

function minOf(el: El) {
  return typeOf(el)?.min ?? { w: LIMITS.minSide, h: LIMITS.minSide };
}

function nextName(label: string, els: El[]): string {
  const used = new Set(els.map((e) => e.name));
  if (!used.has(label)) return label;
  for (let i = 2; ; i++) if (!used.has(`${label} ${i}`)) return `${label} ${i}`;
}

/** Adds an element of `type` at `rect` (or centred at its default size) and selects it. */
export function addElement(type: string, rect?: Box, props?: Record<string, PropValue>): string | null {
  const T = REGISTRY.get(type);
  if (!T) return null;
  set({ addOpen: false });
  const els = scene().elements;
  if (T.single) {
    const existing = els.find((e) => e.type === type);
    if (existing) {
      select([existing.id]);
      toast(`This layout already has the ${T.label.toLowerCase()}. It's selected.`);
      return null;
    }
  }
  if (els.length >= LIMITS.maxElements) {
    toast(`A layout holds up to ${LIMITS.maxElements} elements.`);
    return null;
  }
  const n = els.filter((e) => e.type === type).length;
  const off = (n % 6) * 32;
  const box = clampBox(
    rect ?? { x: 960 - T.size.w / 2 + off, y: 540 - T.size.h / 2 + off, w: T.size.w, h: T.size.h },
    T.min.w,
    T.min.h,
  );
  const el: El = {
    id: type === 'spotify' ? 'spotify' : newId(type),
    type,
    name: T.single ? T.label : nextName(T.label, els),
    rect: box,
    hidden: false,
    locked: false,
    avoid: T.avoidByDefault,
    props: { ...T.defaults, ...(type==='countdown'?{reset:new Date().toISOString()}:{}), ...props },
  };
  commit((d) => sceneOf(d).elements.push(el));
  select([el.id]);
  return el.id;
}

export function duplicate(ids: string[]) {
  const fresh: string[] = [];
  commit((d) => {
    const sc = sceneOf(d);
    for (const id of ids) {
      const el = sc.elements.find((e) => e.id === id);
      if (!el || typeOf(el)?.single || sc.elements.length >= LIMITS.maxElements) continue;
      const c = clone(el);
      c.id = newId(el.type);
      c.name = nextName(el.name, sc.elements).slice(0, LIMITS.maxName);
      c.locked = false;
      c.rect = clampBox({ ...c.rect, x: c.rect.x + 24, y: c.rect.y + 24 }, c.rect.w, c.rect.h);
      sc.elements.push(c);
      fresh.push(c.id);
    }
  });
  if (fresh.length) select(fresh);
}

export function remove(ids: string[]) {
  const keep = scene().elements.filter((e) => ids.includes(e.id) && e.locked);
  commit((d) => {
    const sc = sceneOf(d);
    sc.elements = sc.elements.filter((e) => !ids.includes(e.id) || e.locked);
  });
  select(keep.map((e) => e.id));
  if (keep.length) toast('Locked elements stay. Unlock them to delete.');
}

/** Moves one element `by` places in paint order (+1 is forward, toward the top of the list). */
export function reorder(id: string, by: number) {
  commit((d) => {
    const els = sceneOf(d).elements;
    const from = els.findIndex((e) => e.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(els.length - 1, from + by));
    const [el] = els.splice(from, 1);
    els.splice(to, 0, el);
  });
}

export function nudge(ids: string[], dx: number, dy: number) {
  commit(
    (d) => {
      for (const id of ids)
        editEl(d, id, (el) => {
          if (!el.locked) el.rect = clampBox({ ...el.rect, x: el.rect.x + dx, y: el.rect.y + dy }, el.rect.w, el.rect.h);
        });
    },
    'nudge:' + ids.join(','),
  );
}

export function setRect(id: string, k: 'x' | 'y' | 'w' | 'h', n: number) {
  commit((d) =>
    editEl(d, id, (el) => {
      const m = minOf(el);
      el.rect = clampBox({ ...el.rect, [k]: n }, m.w, m.h);
    }),
  );
}

export function setProp(id: string, key: string, value: string | number | boolean, coalesceKey?: string) {
  commit((d) => editEl(d, id, (el) => (el.props[key] = value)), coalesceKey);
}

export function setFlag(id: string, key: 'hidden' | 'locked' | 'avoid', value: boolean) {
  commit((d) => editEl(d, id, (el) => (el[key] = value)));
}

export function rename(id: string, name: string) {
  commit((d) => editEl(d, id, (el) => (el.name = name.slice(0, LIMITS.maxName))), 'name:' + id);
}

export function testHello() {
  send('testHello');
}

export function copyUrl(which: keyof Urls) {
  if (!get().urls[which]) return;
  send('copyUrl', { which });
}

/** With the OBS plugin: OBS's live output behind the canvas, or the last picture held still. */
export function setMirror(on: boolean) {
  if (get().mirror === on) return;
  set(on ? { mirror: true } : { mirror: false, stillLive: false });
  send('mirror', { on });
}

export function openSettings() {
  send('openSettings');
}

/* ---------------------------------------------------------------- layouts */

/** Puts a layout on the canvas. Editing a layout never puts it live. */
export function editLayout(id: string) {
  set({ editingId: id, sel: [], chaosSel: false, renaming: null, addOpen: false });
}

export function addLayout() {
  const doc = get().doc;
  if (doc.scenes.length >= LIMITS.maxScenes) {
    toast(`You can have up to ${LIMITS.maxScenes} layouts.`);
    return;
  }
  const used = new Set(doc.scenes.map((s) => s.name));
  let name = 'New layout';
  for (let i = 2; used.has(name); i++) name = `New layout ${i}`;
  const id = newId('layout');
  commit((d) => d.scenes.push({ id, name, elements: [], showFor: [] }));
  editLayout(id);
  set({ renaming: id });
}

export function renameLayout(id: string, name: string) {
  const clean = name.trim().slice(0, LIMITS.maxName);
  if (!clean) return;
  commit((d) => {
    const s = d.scenes.find((x) => x.id === id);
    if (s) s.name = clean;
  }, 'layout-name:' + id);
}

export function deleteLayout(id: string) {
  const doc = get().doc;
  if (doc.scenes.length <= 1) {
    toast('You need at least one layout.');
    return;
  }
  const gone = doc.scenes.find((s) => s.id === id);
  commit((d) => {
    d.scenes = d.scenes.filter((s) => s.id !== id);
  });
  if (get().editingId === id) set({ editingId: null, sel: [], chaosSel: false });
  if (gone) toast(`Deleted ${gone.name}. Ctrl+Z brings it back.`);
}

/** Puts a layout live now. It stays live until the next change of game or category. */
export function makeLive(id: string) {
  const st = get();
  if (st.doc.activeSceneId === id) return;
  // ChaosBot owns which layout is live, so this is not an undo step. It answers with the document.
  set({ doc: { ...st.doc, activeSceneId: id } });
  send('makeLive', { sceneId: id });
}

const sameTrigger = (a: Trigger, b: Trigger) => a.kind === b.kind && a.value === b.value;

/** Lists a game or category on the layout being edited. Each one belongs to one layout, so it moves here. */
export function addTrigger(t: Trigger) {
  const here = scene();
  if (here.showFor.some((x) => sameTrigger(x, t))) return;
  if (here.showFor.length >= LIMITS.maxTriggers) {
    toast(`A layout can list up to ${LIMITS.maxTriggers} games and categories.`);
    return;
  }
  const from = get().doc.scenes.find((s) => s.id !== here.id && s.showFor.some((x) => sameTrigger(x, t)));
  commit((d) => {
    for (const s of d.scenes) s.showFor = s.showFor.filter((x) => !sameTrigger(x, t));
    sceneOf(d).showFor.push({ ...t, label: t.label.slice(0, LIMITS.maxName) });
  });
  if (from) toast(`Moved ${t.label} here from ${from.name}.`);
}

export function removeTrigger(t: Trigger) {
  commit((d) => {
    const s = sceneOf(d);
    s.showFor = s.showFor.filter((x) => !sameTrigger(x, t));
  });
}

export function searchCategories(query: string) {
  set({ catQuery: query });
  const q = query.trim();
  if (!q) set({ catResults: [] });
  else send('searchCategories', { query: q.slice(0, 50) });
}

/* ---------------------------------------------------------------- Chaos */

export function selectChaos() {
  set({ chaosSel: true, sel: [], addOpen: false, tool: 'select' });
}

/** Changes one of Chaos's settings. They are saved by ChaosBot, outside the layout and its undo. */
export function setChaos(patch: Partial<Pick<Chaos, 'presentation' | 'edges' | 'muted'>>) {
  const c = get().chaos;
  if (!c) return;
  set({ chaos: { ...c, ...patch } });
  send('setChaos', patch);
}

export function toggleEdge(edge: string) {
  const c = get().chaos;
  if (!c || !c.validEdges.includes(edge)) return;
  const on = c.edges.includes(edge);
  if (on && c.edges.length === 1) {
    toast('Chaos needs at least one edge to come in from.');
    return;
  }
  setChaos({ edges: on ? c.edges.filter((e) => e !== edge) : [...c.edges, edge] });
}

/* ---------------------------------------------------------------- pictures */

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Sends a picture to ChaosBot to store; the element shows it once ChaosBot answers. */
export function pickImage(id: string, file: File) {
  if (!IMAGE_TYPES.includes(file.type)) {
    toast('That is not a PNG, JPG, GIF or WebP picture.');
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    toast('Pictures can be up to 8 MB.');
    return;
  }
  const name = file.name.slice(0, 120) || 'picture';
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result !== 'string') return;
    set({ uploads: { ...get().uploads, [name]: id } });
    send('addImage', { name, data: reader.result });
  };
  reader.onerror = () => toast('That picture could not be read.');
  reader.readAsDataURL(file);
}

/** A dropped picture becomes an Image element where it landed. */
export function dropImage(file: File, at: { x: number; y: number }) {
  const T = REGISTRY.get('image')!;
  const id = addElement('image', { x: at.x - T.size.w / 2, y: at.y - T.size.h / 2, w: T.size.w, h: T.size.h });
  if (id) pickImage(id, file);
}

/** ChaosBot stored the picture. A new Image takes the picture's shape, keeping its width. */
export function imageStored(name: string, file: string, size?: { w: number; h: number }) {
  const uploads = { ...get().uploads };
  const id = uploads[name];
  delete uploads[name];
  set({ uploads });
  if (!id) return;
  commit((d) =>
    editEl(d, id, (el) => {
      const first = !el.props.file;
      el.props.file = file;
      if (first && size && size.w > 0 && size.h > 0) el.rect = clampBox({ ...el.rect, h: Math.round((el.rect.w * size.h) / size.w) }, 16, 16);
    }),
  );
}

export function imageFailed(name: string, text: string) {
  const uploads = { ...get().uploads };
  delete uploads[name];
  set({ uploads });
  toast(text || 'That picture could not be added.');
}

/* ---------------------------------------------------------------- sounds and alerts */

const SOUND_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave'];

/** Sends a sound to ChaosBot to store; the element plays it once ChaosBot answers. */
export function pickSound(id: string, key: string, file: File) {
  if (!SOUND_TYPES.includes(file.type) && !/\.(mp3|ogg|wav)$/i.test(file.name)) {
    toast('That is not an MP3, OGG or WAV sound.');
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    toast('Sounds can be up to 8 MB.');
    return;
  }
  const name = file.name.slice(0, 120) || 'sound';
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result !== 'string') return;
    set({ uploads: { ...get().uploads, ['sound:' + name]: id + '\n' + key } });
    send('addSound', { name, data: reader.result });
  };
  reader.onerror = () => toast('That sound could not be read.');
  reader.readAsDataURL(file);
}

export function soundStored(name: string, file: string) {
  const uploads = { ...get().uploads };
  const target = uploads['sound:' + name];
  delete uploads['sound:' + name];
  set({ uploads });
  if (!target) return;
  const [id, key] = target.split('\n');
  commit((d) =>
    editEl(d, id, (el) => {
      el.props[key] = file;
    }),
  );
}

export function soundFailed(name: string, text: string) {
  const uploads = { ...get().uploads };
  delete uploads['sound:' + name];
  set({ uploads });
  toast(text || 'That sound could not be added.');
}

/** A test alert: drawn on the canvas here, and sent to OBS through ChaosBot. */
export function testAlert(kind: string) {
  window.dispatchEvent(new CustomEvent('chaos-test-alert', { detail: kind }));
  send('testAlert', { kind });
}

/** Opens the Twitch sign-in again, asking for the follower permission too. */
export function reconnectTwitch() {
  send('reconnectTwitch');
}
