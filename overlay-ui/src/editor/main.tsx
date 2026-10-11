import { render } from 'preact';
import '../shared/overlay.css';
import '../spotify/spotify.css';
import './editor.css';
import './kinds';
import { duplicate, imageFailed, imageStored, nudge, remove, reorder, soundFailed, soundStored } from './actions';
import { imageUrl, isImageName, isSoundName, setEditorImageBase } from '../shared/images';
import { App } from './App';
import { described, describeFailed } from './describing';
import { listen, send } from './bridge';
import { emptyDoc, readDoc } from './model';
import type { Category, Chaos, Game } from './store';
import { get, markCopied, receiveDoc, redo, scene, select, set, toast, undo } from './store';

listen((m) => {
  switch (m.type) {
    case 'init':
      set({ games: readGames(m.body.games), category: readCategory(m.body.category), chaos: readChaos(m.body.chaos) });
      setEditorImageBase(String(m.body.imageBase ?? ''));
      set({ follows: readFollows(m.body.follows) });
      setSources(m.body.chaosUrl, m.body.spotifyUrl, m.body.plugin, true);
      receiveDoc(readDoc(m.body.doc) ?? emptyDoc());
      break;
    case 'games':
      set({ games: readGames(m.body.games) });
      break;
    case 'category':
      set({ category: readCategory(m.body.category) });
      break;
    case 'categories':
      // A late answer to an older query is dropped.
      if (String(m.body.query ?? '').trim() === get().catQuery.trim()) set({ catResults: readCategories(m.body.items) });
      break;
    case 'chaos':
      set({ chaos: readChaos(m.body.chaos) });
      break;
    case 'doc': {
      const d = readDoc(m.body.doc);
      if (d) receiveDoc(d);
      break;
    }
    case 'imageAdded': {
      const name = String(m.body.name ?? '');
      const file = m.body.file;
      const url = imageUrl(file, false);
      if (!isImageName(file) || !url) {
        imageFailed(name, 'That picture could not be added.');
        break;
      }
      // Measured first, so a new Image can take the picture's shape.
      const img = new Image();
      img.onload = () => imageStored(name, file, { w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => imageStored(name, file);
      img.src = url;
      break;
    }
    case 'soundAdded': {
      const name = String(m.body.name ?? '');
      if (isSoundName(m.body.file)) soundStored(name, m.body.file);
      else soundFailed(name, 'That sound could not be added.');
      break;
    }
    case 'soundFailed':
      soundFailed(String(m.body.name ?? ''), String(m.body.text ?? ''));
      break;
    case 'follows':
      set({ follows: readFollows(m.body) });
      break;
    case 'imageFailed':
      imageFailed(String(m.body.name ?? ''), String(m.body.text ?? ''));
      break;
    case 'saved':
      set({ saved: 'saved' });
      break;
    case 'error':
      set({ saved: 'error' });
      toast(String(m.body.text ?? 'That change could not be saved.'));
      break;
    case 'still': {
      const src = typeof m.body.src === 'string' && m.body.src.startsWith('data:image/') ? m.body.src : null;
      const live = m.body.live === true;
      // A live frame that arrives after the streamer froze the picture is dropped.
      if (live && !get().mirror) break;
      set({ still: src, stillLive: live && !!src });
      break;
    }
    case 'described':
      described(String(m.body.text ?? ''));
      break;
    case 'describeFailed':
      describeFailed(String(m.body.text ?? ''));
      break;
    case 'sources':
      setSources(m.body.chaosUrl, m.body.spotifyUrl, m.body.plugin);
      break;
    case 'toast':
      toast(String(m.body.text ?? ''));
      break;
    case 'copied':
      markCopied(String(m.body.which ?? ''));
      break;
  }
});

/** The browser source addresses, and with the OBS plugin, its live picture if the streamer wants it. */
// `fresh` is an init: the view-model starts with the preview off each time the page comes back.
function setSources(chaosUrl: unknown, spotifyUrl: unknown, plugin: unknown, fresh = false) {
  const on = plugin === true;
  const was = get().plugin;
  set({ urls: { chaos: String(chaosUrl ?? ''), spotify: String(spotifyUrl ?? '') }, plugin: on });
  if (on && (fresh || !was) && get().mirror) send('mirror', { on: true });
  if (!on && was) set({ stillLive: false });
}

function readCategory(raw: unknown): Category | null {
  const c = raw as { id?: unknown; name?: unknown } | null;
  return c && typeof c.id === 'string' && c.id && typeof c.name === 'string' ? { id: c.id, name: c.name } : null;
}

function readCategories(raw: unknown): Category[] {
  return Array.isArray(raw) ? raw.map(readCategory).filter((c): c is Category => !!c) : [];
}

function readGames(raw: unknown): Game[] {
  return readCategories(raw);
}

function readChaos(raw: unknown): Chaos | null {
  const c = raw as Partial<Chaos> | null;
  if (!c || (c.presentation !== 'peek' && c.presentation !== 'full')) return null;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { presentation: c.presentation, edges: strs(c.edges), validEdges: strs(c.validEdges), muted: !!c.muted };
}

function typing(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

window.addEventListener('keydown', (e) => {
  if (!get().loaded || typing(e.target)) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const sel = get().sel;
  if (ctrl && k === 'z' && !e.shiftKey) undo();
  else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
  else if (ctrl && k === 'd' && sel.length) duplicate(sel);
  else if (ctrl && k === 'a') select(scene().elements.map((x) => x.id));
  else if (ctrl) return;
  else if ((k === 'delete' || k === 'backspace') && sel.length) remove(sel);
  else if (k.startsWith('arrow') && sel.length) {
    const step = e.shiftKey ? 10 : 1;
    nudge(sel, k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
  } else if ((k === '[' || k === ']') && sel.length === 1) reorder(sel[0], k === ']' ? 1 : -1);
  else if (k === 'v') set({ tool: 'select' });
  else if (k === 'escape') {
    if (get().tool === 'draw') set({ tool: 'select' });
    else select([]);
  } else return;
  e.preventDefault();
});

render(<App />, document.getElementById('app')!);
send('ready');

/** `{ available }` from ChaosBot; anything else is unknown, and the panel says nothing. */
function readFollows(v: unknown): boolean | null {
  const a = v && typeof v === 'object' ? (v as { available?: unknown }).available : undefined;
  return typeof a === 'boolean' ? a : null;
}
