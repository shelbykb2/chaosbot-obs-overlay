import { useEffect, useState } from 'preact/hooks';
import { hosted, send } from './bridge';
import type { Guide } from './geometry';
import { History } from './history';
import { clone, emptyDoc, sceneById, type Doc, type El, type Scene } from './model';

/* Editor state. The document comes from and goes back to OverlayCreatorViewModel over the
   bridge; undo lives here, next to the gestures. Every finished change is sent once as a
   commit, and a drag in progress is sent as a preview so OBS follows it without a save. */

export type Tool = 'select' | 'draw';

/** The OBS browser source addresses the Sources card offers to copy. */
export interface Urls {
  chaos: string;
  spotify: string;
}

/** A game ChaosBot has a profile for. */
export interface Game {
  id: string;
  name: string;
}

/** A Twitch category. */
export interface Category {
  id: string;
  name: string;
}

/** Chaos's own settings. They live in ChaosBot's overlay settings, the same in every layout. */
export interface Chaos {
  presentation: 'peek' | 'full';
  edges: string[];
  /** The edges this presentation can use. */
  validEdges: string[];
  muted: boolean;
}

export interface State {
  doc: Doc;
  /** The layout on the canvas. Not the same as the live one (doc.activeSceneId). */
  editingId: string | null;
  /** Chaos is selected in the Elements list; then sel is empty. */
  chaosSel: boolean;
  chaos: Chaos | null;
  games: Game[];
  /** The stream's category on Twitch right now, when ChaosBot can see it. */
  category: Category | null;
  catQuery: string;
  catResults: Category[];
  /** The layout whose name is being edited in the layout strip. */
  renaming: string | null;
  /** False until ChaosBot has sent the stored document. */
  loaded: boolean;
  sel: string[];
  tool: Tool;
  snap: boolean;
  showNoGo: boolean;
  playing: boolean;
  addOpen: boolean;
  guides: Guide[];
  toast: string;
  saved: 'saved' | 'saving' | 'error';
  /** The game behind the canvas (a data: URL), or null for the empty canvas. */
  still: string | null;
  urls: Urls;
  copied: string | null;
  /** Elements waiting for ChaosBot to store a picture, by the file name sent with it. */
  uploads: Record<string, string>;
  /** Whether Twitch lets ChaosBot see follows; null until ChaosBot says (and in a plain browser). */
  follows: boolean | null;
  /** The OBS plugin serves the overlay, so the addresses are its own and OBS's picture can be live. */
  plugin: boolean;
  /** With the plugin: the canvas shows OBS live (true) or holds the last picture (false). */
  mirror: boolean;
  /** The picture behind the canvas is OBS's live output, not a still of the game window. */
  stillLive: boolean;
  /** The Describe a layout panel: open, asking for a change to the draft, and the last failure. */
  describe: { open: boolean; change: boolean; error: string };
  /** A description is with the model. */
  describing: boolean;
  /** A described layout the streamer has not kept yet, and what the model sent that was left out. */
  draft: { id: string; dropped: string[] } | null;
}

let state: State = {
  doc: emptyDoc(),
  editingId: null,
  chaosSel: false,
  chaos: null,
  games: [],
  category: null,
  catQuery: '',
  catResults: [],
  renaming: null,
  loaded: false,
  sel: [],
  tool: 'select',
  snap: true,
  showNoGo: true,
  playing: true,
  addOpen: false,
  guides: [],
  toast: '',
  saved: 'saved',
  still: null,
  urls: { chaos: '', spotify: '' },
  copied: null,
  uploads: {},
  follows: null,
  plugin: false,
  mirror: true,
  stillLive: false,
  describe: { open: false, change: false, error: '' },
  describing: false,
  draft: null,
};

const history = new History<Doc>();
const subs = new Set<() => void>();
let gestureStart: Doc | null = null;
let toastTimer = 0;
let copiedTimer = 0;
let previewAt = 0;
let previewTimer = 0;

const PREVIEW_MS = 33;

function emit() {
  for (const fn of subs) fn();
}

export function get(): State {
  return state;
}

export function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

export function useStore(): State {
  const [, force] = useState(0);
  const seen = state;
  useEffect(() => {
    const fn = () => force((x) => x + 1);
    subs.add(fn);
    // Effects run after paint: a change in between (the first init) would otherwise be missed.
    if (state !== seen) fn();
    return () => {
      subs.delete(fn);
    };
  }, []);
  return state;
}

/** The layout being edited. */
export function scene(): Scene {
  return sceneById(state.doc, state.editingId);
}

/** The layout being edited, inside an edit of a copy of the document. */
export function sceneOf(doc: Doc): Scene {
  return sceneById(doc, state.editingId);
}

export function selected(): El[] {
  const els = scene().elements;
  return state.sel.map((id) => els.find((e) => e.id === id)).filter((e): e is El => !!e);
}

export function canUndo() {
  return history.past.length > 0;
}

export function canRedo() {
  return history.future.length > 0;
}

function sendCommit() {
  // Outside ChaosBot nothing saves, so nothing will answer.
  state = { ...state, saved: hosted ? 'saving' : 'saved' };
  send('commit', { doc: state.doc });
}

/** One undoable change. Calls with the same coalesce key within 600 ms make one undo step. */
export function commit(edit: (doc: Doc) => void, coalesceKey?: string) {
  const next = clone(state.doc);
  edit(next);
  if (JSON.stringify(next) === JSON.stringify(state.doc)) return;
  history.record(state.doc, performance.now(), coalesceKey);
  state = { ...state, doc: next };
  pruneSelection();
  sendCommit();
  emit();
}

/** A drag in progress: the document changes live and OBS follows; history and the save happen once, at the end. */
export function beginGesture() {
  gestureStart = state.doc;
  history.cut();
}

export function live(edit: (doc: Doc) => void) {
  const next = clone(state.doc);
  edit(next);
  state = { ...state, doc: next };
  emit();
  sendPreview();
}

/** At most one preview per 33 ms, and the last one always goes. */
function sendPreview() {
  const wait = PREVIEW_MS - (performance.now() - previewAt);
  if (wait <= 0) {
    previewAt = performance.now();
    send('preview', { sceneId: scene().id, elements: scene().elements });
  } else if (!previewTimer) {
    previewTimer = window.setTimeout(() => {
      previewTimer = 0;
      if (gestureStart) sendPreview();
    }, wait);
  }
}

export function endGesture() {
  if (!gestureStart) return;
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = 0;
  }
  const start = gestureStart;
  gestureStart = null;
  if (JSON.stringify(start) !== JSON.stringify(state.doc)) {
    history.record(start, performance.now());
    history.cut();
    sendCommit();
  }
  send('endPreview');
  set({ guides: [] });
}

export function undo() {
  const prev = history.undo(state.doc);
  if (!prev) return;
  state = { ...state, doc: prev };
  pruneSelection();
  sendCommit();
  emit();
}

export function redo() {
  const next = history.redo(state.doc);
  if (!next) return;
  state = { ...state, doc: next };
  pruneSelection();
  sendCommit();
  emit();
}

/** A document from ChaosBot: replaces the one here, with no undo step. */
export function receiveDoc(doc: Doc) {
  if (gestureStart) gestureStart = null;
  history.reset();
  // The canvas stays on its layout when another one goes live; it starts on the live one.
  const editingId = state.editingId && doc.scenes.some((s) => s.id === state.editingId) ? state.editingId : doc.activeSceneId;
  state = { ...state, doc, editingId, loaded: true };
  pruneSelection();
  emit();
}

function pruneSelection() {
  const ids = new Set(scene().elements.map((e) => e.id));
  if (state.sel.every((id) => ids.has(id))) return;
  state = { ...state, sel: state.sel.filter((id) => ids.has(id)) };
}

export function editEl(doc: Doc, id: string, fn: (el: El) => void) {
  const el = sceneOf(doc).elements.find((e) => e.id === id);
  if (el) fn(el);
}

export function select(ids: string[]) {
  set({ sel: ids, chaosSel: false, addOpen: false });
}

export function toast(text: string) {
  if (toastTimer) clearTimeout(toastTimer);
  set({ toast: text });
  toastTimer = window.setTimeout(() => set({ toast: '' }), 3200);
}

export function markCopied(which: string) {
  if (copiedTimer) clearTimeout(copiedTimer);
  set({ copied: which });
  copiedTimer = window.setTimeout(() => set({ copied: null }), 1800);
}
