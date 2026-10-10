/* The page side of the WebView2 bridge to OverlayCreatorViewModel (ChaosBot.UI).

   Every message is { v: 1, type, body }. The view-model checks each one (size, version, type,
   body shape) and ignores anything else, so this file is a convenience, not the guard.

   Page to view-model:
     ready                          the page is listening; answer with init
     commit      { doc }            a finished change; the view-model saves it (debounced)
     commit keeps ChaosBot's activeSceneId: which layout is live is ChaosBot's to say
     preview     { sceneId, elements }  the layout being edited, during a drag; OBS follows it, nothing is saved
     endPreview                     the drag ended (a commit follows when something moved)
     testHello                      pop Chaos in once, for real
     copyUrl     { which }          'chaos' or 'spotify'
     openSettings                   Settings, at Chaos's options
     makeLive    { sceneId }        put this layout live now
     searchCategories { query }     Twitch categories for the Goes live when picker
     setChaos    { presentation?, edges?, muted? }   Chaos's own settings, the same in every layout
     addImage    { name, data }     a picture to store (a data: URL); answered with imageAdded or imageFailed
     addSound    { name, data }     an alert sound to store (a data: URL); answered with soundAdded or soundFailed
     testAlert   { kind }           a test alert in OBS (follow, sub, resub, gift, bits or raid)
     reconnectTwitch                sign in to Twitch again for the follower permission; answered with follows
     describe    { system, user, picture }  ask the model for a layout; picture attaches the one behind the canvas
     mirror      { on }             with the OBS plugin: show OBS's live output behind the canvas, or stop

   View-model to page:
     init        { doc, chaosUrl, spotifyUrl, games, category, chaos, imageBase, follows, plugin }
     doc         { doc }            the stored document changed outside this page (a game switch too)
     games       { games }          [{ id, name }], the games ChaosBot has profiles for
     category    { category }       { id, name } or null, the stream's Twitch category now
     categories  { query, items }   the answer to searchCategories
     chaos       { chaos }          { presentation, edges, validEdges, muted }
     imageAdded  { file, name }     the picture is stored as `file` (sha256.ext)
     imageFailed { name, text }     it was not, and why
     soundAdded  { file, name }     the sound is stored as `file` (sha256.ext)
     soundFailed { name, text }     it was not, and why
     follows     { available }      whether Twitch lets ChaosBot see follows
     saved                          the last commit is on disk
     error       { text }           a commit was refused or could not be saved
     still       { src, live }      the picture behind the canvas (a data: URL), or null; live when it is OBS's output
     described   { text }           the model's answer to describe, as it came
     describeFailed { text }        why there is no answer, in plain words
     sources     { chaosUrl, spotifyUrl, plugin }  the browser source addresses changed (the OBS plugin came or went)
     toast       { text }
     copied      { which }

   Outside WebView2 (a plain browser, for development and screenshots) nothing is sent, and
   `?sample=1` loads a sample document so the editor can be tried, and `?plugin=1` acts as if the
   OBS plugin were installed. */

import { addDevImage } from '../shared/images';
import { pluginEditor, pluginListen, pluginSend } from './pluginBridge';

export type Incoming =
  | { type: 'init'; body: { doc: unknown; chaosUrl: string; spotifyUrl: string; games?: unknown; category?: unknown; chaos?: unknown; imageBase?: unknown; follows?: unknown; plugin?: unknown } }
  | { type: 'described'; body: { text: unknown } }
  | { type: 'describeFailed'; body: { text: unknown } }
  | { type: 'sources'; body: { chaosUrl: unknown; spotifyUrl: unknown; plugin: unknown } }
  | { type: 'soundAdded'; body: { file: unknown; name: unknown } }
  | { type: 'soundFailed'; body: { name: unknown; text: unknown } }
  | { type: 'follows'; body: { available: unknown } }
  | { type: 'imageAdded'; body: { file: unknown; name: unknown } }
  | { type: 'imageFailed'; body: { name: unknown; text: unknown } }
  | { type: 'games'; body: { games: unknown } }
  | { type: 'category'; body: { category: unknown } }
  | { type: 'categories'; body: { query: unknown; items: unknown } }
  | { type: 'chaos'; body: { chaos: unknown } }
  | { type: 'doc'; body: { doc: unknown } }
  | { type: 'saved'; body: Record<string, never> }
  | { type: 'error'; body: { text: string } }
  | { type: 'still'; body: { src: string | null; live?: unknown } }
  | { type: 'toast'; body: { text: string } }
  | { type: 'copied'; body: { which: string } };

interface WebView {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
}

const webview: WebView | undefined = (window as unknown as { chrome?: { webview?: WebView } }).chrome?.webview;

/** True inside ChaosBot's WebView2. */
export const hosted = !!webview || pluginEditor();

let devListener: ((msg: Incoming) => void) | null = null;

export function send(type: string, body: Record<string, unknown> = {}): void {
  if (pluginEditor()) { pluginSend(type,body); return; }
  if (webview) webview.postMessage({ v: 1, type, body });
  else devAnswer(type, body);
}

const DEV_CATEGORIES = [
  { id: '509658', name: 'Just Chatting' },
  { id: '509660', name: 'Art' },
  { id: '26936', name: 'Music' },
  { id: '1469308723', name: 'Software and Game Development' },
];

// Development: answer what the view-model would, so the editor can be tried in a browser.
function devAnswer(type: string, body: Record<string, unknown>) {
  if (!devListener) return;
  const fn = devListener;
  if (type === 'searchCategories') {
    const q = String(body.query ?? '').toLowerCase();
    queueMicrotask(() => fn({ type: 'categories', body: { query: body.query, items: DEV_CATEGORIES.filter((c) => c.name.toLowerCase().includes(q)) } }));
  } else if (type === 'addImage') {
    // A made-up stored name; the picture stays in the page.
    const data = String(body.data ?? '');
    const file = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('') + '.png';
    addDevImage(file, data);
    queueMicrotask(() => fn({ type: 'imageAdded', body: { file, name: body.name } }));
  } else if (type === 'addSound') {
    const data = String(body.data ?? '');
    const file = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('') + '.mp3';
    addDevImage(file, data);
    queueMicrotask(() => fn({ type: 'soundAdded', body: { file, name: body.name } }));
  } else if (type === 'describe') {
    // A fixed answer, with one value the editor does not have so the "left out" note shows.
    const text = JSON.stringify({
      name: 'Cozy corner',
      elements: [
        { type: 'chat', x: 24, y: 520, w: 420, h: 520, props: { style: 'bubbles', background: 'soft', glow: 'lots' } },
        { type: 'spotify', x: 1391, y: 24, w: 505, h: 109 },
      ],
    });
    setTimeout(() => fn({ type: 'described', body: { text } }), 900);
  } else if (type === 'setChaos') {
    // OverlaySpawn.Normalize: keep the edges the style allows, and none left means all of them.
    const presentation = body.presentation === 'full' || body.presentation === 'peek' ? body.presentation : devChaos.presentation;
    const validEdges = presentation === 'full' ? ['left', 'right', 'top', 'bottom'] : ['left', 'right'];
    const asked = Array.isArray(body.edges) ? (body.edges as string[]) : devChaos.edges;
    const kept = asked.filter((e) => validEdges.includes(e));
    devChaos = { presentation, edges: kept.length ? kept : validEdges, validEdges, muted: typeof body.muted === 'boolean' ? body.muted : devChaos.muted };
    const chaos = devChaos;
    queueMicrotask(() => fn({ type: 'chaos', body: { chaos } }));
  }
}

let devChaos = { presentation: 'peek', edges: ['left', 'right'], validEdges: ['left', 'right'], muted: false };

export function listen(fn: (msg: Incoming) => void): void {
  if (pluginEditor()) { pluginListen(fn); return; }
  if (webview) {
    webview.addEventListener('message', (e) => {
      const m = e.data as { v?: unknown; type?: unknown; body?: unknown } | null;
      if (!m || m.v !== 1 || typeof m.type !== 'string') return;
      fn({ type: m.type, body: (m.body ?? {}) as never } as Incoming);
    });
    return;
  }
  // Development: answer `ready` the way the view-model would.
  devListener = fn;
  const q = new URLSearchParams(location.search);
  const sample = q.get('sample') === '1';
  // `?plugin=1` shows the editor as it is with the OBS plugin installed.
  const plugin = q.get('plugin') === '1';
  const origin = plugin ? 'http://127.0.0.1:5260/' : 'http://127.0.0.1:5051/';
  queueMicrotask(() =>
    fn({
      type: 'init',
      body: {
        doc: sample ? sampleDoc() : null,
        chaosUrl: origin,
        spotifyUrl: origin + 'spotify/',
        plugin,
        games: [
          { id: 'thefinals', name: 'THE FINALS' },
          { id: 'valorant', name: 'VALORANT' },
          { id: 'wardogs', name: 'Wardogs' },
        ],
        category: DEV_CATEGORIES[0],
        chaos: devChaos,
      },
    }),
  );
}

function sampleDoc() {
  return {
    schemaVersion: 1,
    activeSceneId: 'gameplay',
    scenes: [
      {
        id: 'gameplay',
        name: 'Gameplay',
        showFor: [
          { kind: 'game', value: 'wardogs', label: 'Wardogs' },
          { kind: 'game', value: 'valorant', label: 'VALORANT' },
        ],
        elements: [
          { id: 'cam', type: 'nogo', name: 'Facecam', rect: { x: 24, y: 24, w: 416, h: 241 }, hidden: false, locked: false, avoid: true, props: { laugh: true } },
          {
            id: 'spotify',
            type: 'spotify',
            name: 'Now playing',
            rect: { x: 24, y: 720, w: 600, h: 210 },
            hidden: false,
            locked: false,
            avoid: true,
            props: { style: 'card', accent: 'auto', backdrop: 'art', opacity: 1, visualizer: 'auto', coverSheen: true },
          },
        ],
      },
      { id: 'chatting', name: 'Just chatting', showFor: [{ kind: 'category', value: '509658', label: 'Just Chatting' }], elements: [] },
      { id: 'brb', name: 'Be right back', showFor: [], elements: [] },
    ],
  };
}
