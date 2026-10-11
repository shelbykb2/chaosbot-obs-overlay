import { useEffect, useRef } from 'preact/hooks';
import { isStale, moduleScripts } from './freshness';
import { chaosOrigin } from './env';

/**
 * Connection to the overlay hub (/overlay/hub). The SignalR client is the copy the Chaos page
 * already ships (/chaos/signalr.min.js), loaded on demand, so it is not bundled twice and a
 * demo page never loads it.
 *
 * Pass a handler for each message the page uses; the messages it does not list are
 * acknowledged and ignored.
 */
export type HubHandlers = Record<string, (arg: any) => void>;

// The hub also sends these to every page.
const KNOWN = ['overlayConfig', 'chaos', 'nowPlaying', 'spotifyConfig', 'spectrum', 'scene', 'scenePreview'];

interface SignalRConnection {
  state: string;
  on(name: string, fn: (arg: unknown) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  onreconnected(fn: () => void): void;
  invoke(method: string, ...args: unknown[]): Promise<unknown>;
}
interface SignalRGlobal {
  HubConnectionBuilder: new () => {
    withUrl(url: string): any;
  };
  HubConnectionState: { Connected: string; Disconnected: string };
}

let loading: Promise<SignalRGlobal> | null = null;

function loadSignalR(): Promise<SignalRGlobal> {
  const w = window as unknown as { signalR?: SignalRGlobal };
  if (w.signalR) return Promise.resolve(w.signalR);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/chaos/signalr.min.js?v=8.0.0';
    s.onload = () => (w.signalR ? resolve(w.signalR) : reject(new Error('signalR missing')));
    s.onerror = () => {
      loading = null;
      reject(new Error('signalr.min.js failed to load'));
    };
    document.head.append(s);
  });
  return loading;
}

// The hub needs to know which page this is: only Spotify pages get spectrum frames (and the audio
// capture runs only while one is connected), and only scene pages get the layout. A scene page asks
// for the spectrum with Feeds once it knows its layout holds a card.
const PAGE = location.pathname.split('/').filter(Boolean)[0];
const HUB_URL = (location.port === '5260' || location.port === '5261' ? 'http://127.0.0.1:5261' : chaosOrigin()) + (PAGE === 'spotify' || PAGE === 'scene' ? '/overlay/hub?page=' + PAGE : '/overlay/hub');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Read before the hub script is added, so only the page's own code is in it.
const RUNNING = moduleScripts(document.documentElement.outerHTML);
let reloading = false;

/** Reloads the page when the bot (just reconnected, so maybe updated) serves newer code than this. */
async function reloadIfStale(): Promise<void> {
  if (reloading) return;
  try {
    const res = await fetch(location.href, { cache: 'no-store' });
    if (!res.ok || !isStale(RUNNING, moduleScripts(await res.text()))) return;
    reloading = true;
    location.reload();
  } catch {
    // The bot is still coming up: the next connect checks again.
  }
}

/* One connection per page, shared by every useHub on it: a scene page draws a Spotify card that
   listens for its own messages, and that must not open a second socket. */

const subs = new Set<{ current: HubHandlers }>();
const listening = new Set<string>();
let connection: SignalRConnection | null = null;
let sr: SignalRGlobal | null = null;
let starting: Promise<void> | null = null;
let disposed = true;
let bounceTimer = 0;
let feeds: string[] = [];

const connected = () => !!connection && connection.state === sr!.HubConnectionState.Connected;

// State the hub sends once on connect. A piece that mounts later (a scene page draws its card only
// after the layout arrives) gets the last one straight away instead of waiting for the next change.
const STATE = new Set(['overlayConfig', 'nowPlaying', 'spotifyConfig', 'scene', 'scenePreview', 'commandFeed']);
const last = new Map<string, unknown>();

function dispatch(name: string, arg: unknown) {
  if (STATE.has(name)) last.set(name, arg);
  for (const s of subs) s.current[name]?.(arg);
}

function listen(names: Iterable<string>) {
  if (!connection) return;
  for (const name of names) {
    if (listening.has(name)) continue;
    listening.add(name);
    connection.on(name, (arg) => dispatch(name, arg));
  }
}

function sendFeeds() {
  if (connected()) connection!.invoke('Feeds', feeds).catch((err) => console.error(err));
}

/** Feeds this page needs beyond the defaults (e.g. 'spotify' for the spectrum). Sent again after every reconnect. */
export function setFeeds(next: string[]) {
  const sorted = [...new Set(next)].sort();
  if (sorted.join() === feeds.join()) return;
  feeds = sorted;
  sendFeeds();
}

function afterConnect() {
  void reloadIfStale();
  if (feeds.length) sendFeeds();
}

async function startHub(): Promise<void> {
  if (!connection || connected()) return;
  if (starting) return starting;
  starting = (async () => {
    while (!disposed) {
      if (connected()) return;
      try {
        if (connection!.state === sr!.HubConnectionState.Disconnected) await connection!.start();
        if (connected()) {
          afterConnect();
          return;
        }
      } catch (err) {
        console.error(err);
      }
      await sleep(1000);
    }
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

// OBS often keeps a dead socket marked Connected (no close event, so automatic reconnect
// never runs). Bounce on show so opening OBS does not need a manual Refresh.
function bounceHub() {
  if (bounceTimer) clearTimeout(bounceTimer);
  bounceTimer = window.setTimeout(async () => {
    bounceTimer = 0;
    try {
      if (starting) await starting;
      if (connection && connection.state !== sr!.HubConnectionState.Disconnected) await connection.stop();
    } catch (err) {
      console.error(err);
    }
    await startHub();
  }, 250);
}

function obsShown(ev: Event) {
  const d = (ev as CustomEvent<{ visible?: boolean; active?: boolean }>).detail;
  if (d && (d.visible === false || d.active === false)) return;
  bounceHub();
}
function docShown() {
  if (!document.hidden) bounceHub();
}

function open() {
  disposed = false;
  if (connection) {
    void startHub();
    return;
  }
  loadSignalR().then(
    (lib) => {
      if (disposed || connection) return;
      sr = lib;
      connection = new lib.HubConnectionBuilder()
        .withUrl(HUB_URL)
        .withAutomaticReconnect({ nextRetryDelayInMilliseconds: () => 1000 })
        .build() as SignalRConnection;
      listening.clear();
      listen(KNOWN);
      for (const s of subs) listen(Object.keys(s.current));
      connection.onreconnected(afterConnect);
      window.addEventListener('obsSourceVisibleChanged', obsShown);
      window.addEventListener('obsSourceActiveChanged', obsShown);
      document.addEventListener('visibilitychange', docShown);
      void startHub();
    },
    (err) => console.error(err),
  );
}

function close() {
  disposed = true;
  if (bounceTimer) clearTimeout(bounceTimer);
  bounceTimer = 0;
  window.removeEventListener('obsSourceVisibleChanged', obsShown);
  window.removeEventListener('obsSourceActiveChanged', obsShown);
  document.removeEventListener('visibilitychange', docShown);
  connection?.stop().catch(() => {});
  connection = null;
  last.clear();
}

export function useHub(handlers: HubHandlers, enabled = true) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    subs.add(ref);
    listen(Object.keys(ref.current));
    for (const [name, arg] of last) ref.current[name]?.(arg);
    if (subs.size === 1) open();
    return () => {
      subs.delete(ref);
      if (subs.size === 0) close();
    };
  }, [enabled]);
}
