/* Demo mode (?demo=1). Stands in for the ChaosBot host: the now-playing poller (every 3 s) and
   the spectrum capture (35-byte frames at 30 fps, base64 the way SignalR's JSON protocol sends
   byte[]). Album art is drawn on a canvas, so it is original and same-origin like
   /api/spotify/art. This module is its own chunk; the live page never downloads it.

   The overlay editor renders the card in-page (SpotifyOverlay with `demo`), not through this
   page. A page that frames /spotify/?demo=1 can still drive it:
     query   style, accent, backdrop, opacity, visualizer, sheen (0 = off), and x, y, w, h (fractions of
             1920 x 1080; a missing or non-finite value falls back to the style's default),
             enabled=0 (card hidden)
     message from the parent frame only:
       { type: 'spotifyConfig', config }   config has the hub's spotifyConfig shape
       { type: 'demo', playing: bool }     pause or play the sample track
       { type: 'demo', next: true }        skip to the next sample track
     message to the parent frame, once the listener is wired: { type: 'spotifyDemoReady' }
   window.spotifyDemo exposes the same fake player (setPlaying, next, stopAll, idle, setVolume,
   configure) for tests: idle() reports nothing playing the way Spotify does after a long pause,
   setVolume(0..1) scales the fake spectrum like a quieter player, and configure(patch) sends a
   new spotifyConfig the way a settings change does. */

import { DESIGN, type CardStyle, type NowPlaying } from './types';

type Handlers = {
  nowPlaying: (np: NowPlaying | null) => void;
  spotifyConfig: (cfg: unknown) => void;
  spectrum: (frame: unknown) => void;
};

type Ctx = CanvasRenderingContext2D;
type Rng = () => number;

interface Track {
  trackId: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  bpm: number;
  energy: number;
  seed: number;
  art: (ctx: Ctx, S: number, r: Rng) => void;
  artUrl?: string;
}

const TRACKS: Track[] = [
  { trackId: 'fake-1', title: 'Neon Undertow', artists: ['Mira Okafor'], album: 'Afterglow Engine', durationMs: 221000, bpm: 118, energy: 1.0, seed: 1, art: drawNeon },
  { trackId: 'fake-2', title: 'Glass Orchard', artists: ['The Low Lanterns'], album: 'Quiet Machinery', durationMs: 254000, bpm: 92, energy: 0.8, seed: 2, art: drawOrchard },
  {
    trackId: 'fake-3', title: 'Static Bloom (Extended Night Drive Mix)', artists: ['Lumen Arcade', 'The Velvet Tide Collective'],
    album: 'Signal Garden', durationMs: 402000, bpm: 128, energy: 1.1, seed: 3, art: drawBloom,
  },
];

const TRACK_SECONDS = 8;
const POLL_MS = 3000;

export function startDemo(h: Handlers): () => void {
  const q = new URLSearchParams(location.search);
  const style = (['card', 'pill', 'vinyl'].includes(q.get('style') ?? '') ? q.get('style') : 'card') as CardStyle;
  const { w, h: hh } = DESIGN[style];
  const accent = q.get('accent');
  const num = (key: string, fallback: number) => {
    const v = parseFloat(q.get(key) ?? '');
    return Number.isFinite(v) ? v : fallback;
  };
  let config: Record<string, unknown> = {
    enabled: q.get('enabled') !== '0',
    x: num('x', 24 / 1920),
    y: num('y', (1080 - 150 - hh) / 1080),
    w: num('w', w / 1920),
    h: num('h', hh / 1080),
    style,
    accent: accent ? '#' + accent.replace('#', '') : 'auto',
    backdrop: q.get('backdrop') || 'art',
    opacity: q.get('opacity') || 1,
    visualizer: q.get('visualizer') || 'auto',
    coverSheen: q.get('sheen') !== '0',
  };
  h.spotifyConfig(config);

  for (const t of TRACKS) t.artUrl ??= renderArt(t.art, t.seed);
  const track = (q.get('track') ?? '') !== '' ? Math.max(0, Math.min(TRACKS.length - 1, +q.get('track')! - 1)) : 0;
  const hold = q.get('hold') === '1'; // stay on one track (screenshots)

  const st = { idx: track, playing: true, base: 0, resumedAt: 0, trackPlay: 0, lastTick: 0, lastBeat: -1, rnd: rng(7), volume: 1 };
  let frameTimer = 0;
  let pollTimer = 0;
  const progress = () => st.base + (st.playing ? performance.now() - st.resumedAt : 0);
  const cur = () => TRACKS[st.idx];

  const payload = (jitter: boolean): NowPlaying => {
    const t = cur();
    return {
      trackId: t.trackId, title: t.title, artists: t.artists, album: t.album, artUrl: t.artUrl!,
      durationMs: t.durationMs, isPlaying: st.playing,
      progressMs: Math.round(Math.max(0, progress() + (jitter ? (st.rnd() - 0.5) * 600 : 0))),
    };
  };

  function load(idx: number) {
    st.idx = (idx + TRACKS.length) % TRACKS.length;
    st.base = cur().durationMs * (0.18 + st.rnd() * 0.45);
    st.resumedAt = performance.now();
    st.trackPlay = 0;
    st.lastBeat = -1;
    h.nowPlaying(payload(false));
  }

  function frame() {
    const now = performance.now();
    st.trackPlay += (now - st.lastTick) / 1000;
    st.lastTick = now;
    if (!hold && st.trackPlay >= TRACK_SECONDS) {
      load(st.idx + 1);
      return;
    }
    h.spectrum(toBase64(makeFrame(progress() / 1000, cur(), st)));
  }

  // Like the real capture, frames only flow while something plays.
  function runFrames(on: boolean) {
    if (on && !frameTimer) {
      st.lastTick = performance.now();
      frameTimer = window.setInterval(frame, 1000 / 30);
    } else if (!on && frameTimer) {
      clearInterval(frameTimer);
      frameTimer = 0;
    }
  }

  const api = {
    tracks: TRACKS,
    setPlaying(on: boolean) {
      if (on === st.playing) return;
      if (on) st.resumedAt = performance.now();
      else st.base = progress();
      st.playing = on;
      runFrames(on);
      h.nowPlaying(payload(false));
    },
    isPlaying: () => st.playing,
    next() {
      st.lastTick = performance.now();
      load(st.idx + 1);
    },
    stopAll() {
      st.playing = false;
      runFrames(false);
      h.nowPlaying(null);
    },
    /** Spotify's answer after a long pause: nothing playing, while the player still holds the track. */
    idle() {
      if (st.playing) api.setPlaying(false);
      h.nowPlaying(null);
    },
    setVolume(v: number) {
      st.volume = Math.max(0, Math.min(1, +v || 0));
    },
    configure(patch: Record<string, unknown>) {
      config = { ...config, ...patch };
      h.spotifyConfig(config);
    },
  };
  (window as any).spotifyDemo = api;

  // The editor preview drives the card through postMessage. Only the parent frame is heard, and
  // only when the page is framed. A paused card leaves after the grace period like a live one,
  // so a paused preview goes fully idle.
  const framed = window.parent !== window;
  const onMessage = (e: MessageEvent) => {
    if (!framed || e.source !== window.parent || !e.data || typeof e.data !== 'object') return;
    const msg = e.data as { type?: unknown; config?: unknown; playing?: unknown; next?: unknown };
    if (msg.type === 'spotifyConfig') {
      h.spotifyConfig(msg.config);
    } else if (msg.type === 'demo') {
      if (typeof msg.playing === 'boolean') api.setPlaying(msg.playing);
      if (msg.next === true) api.next();
    }
  };
  window.addEventListener('message', onMessage);
  // Tells the parent frame that messages are heard from now on.
  if (framed) window.parent.postMessage({ type: 'spotifyDemoReady' }, '*');

  load(st.idx);
  runFrames(true);
  pollTimer = window.setInterval(() => {
    if (st.playing) h.nowPlaying(payload(true));
  }, POLL_MS);

  return () => {
    window.removeEventListener('message', onMessage);
    runFrames(false);
    clearInterval(pollTimer);
  };
}

// ---------------------------------------------------------------- fake spectrum

// A drum machine in 32 log bands: kick in the lows on every beat, snare on 2 and 4, hats on
// eighths up top, a wandering lead in the mids, and a breakdown bar with no kick every 8 bars.
function makeFrame(t: number, tr: Track, st: { rnd: Rng; lastBeat: number; volume: number }) {
  const beatLen = 60 / tr.bpm;
  const bt = t / beatLen;
  const beat = Math.floor(bt);
  const ph = bt - beat;
  const breakdown = Math.floor(beat / 4) % 8 === 7;
  const kick = breakdown ? 0 : Math.exp(-ph * 6.5);
  const snare = beat % 2 === 1 ? Math.exp(-ph * 9) : 0;
  const hat = Math.exp(-((bt * 2) % 1) * 14) * (breakdown ? 0.45 : 1);
  const lead = 14 + 7 * Math.sin(t * 0.55 + tr.seed * 2);
  const out = new Uint8Array(35);
  let sum = 0;
  for (let b = 0; b < 32; b++) {
    let v = 0.3 * (1 - (b / 31) * 0.6);
    v += kick * Math.max(0, 1 - b / 6) * 0.72;
    v += 0.2 * (0.5 + 0.5 * Math.sin(bt * Math.PI + b * 0.5)) * Math.max(0, 1 - Math.abs(b - 5) / 4);
    v += 0.36 * Math.exp(-((b - lead) ** 2) / 9) * (0.6 + 0.4 * Math.sin(t * 3.3 + b));
    v += snare * 0.42 * Math.exp(-((b - 16) ** 2) / 28);
    v += hat * 0.5 * Math.max(0, (b - 20) / 11);
    v *= tr.energy * (breakdown ? 0.72 : 1);
    v += (st.rnd() - 0.5) * 0.07;
    v *= st.volume;
    v = Math.max(0, Math.min(1, v));
    out[b] = Math.round(v * 255);
    sum += v;
  }
  const onset = !breakdown && beat !== st.lastBeat && st.volume > 0.05;
  st.lastBeat = beat;
  out[32] = onset ? 1 : 0;
  out[33] = Math.round((sum / 32) * 255);
  // The punch: a hard hit on the kick, the bass line's small moves between.
  out[34] = Math.round((onset ? 0.65 + st.rnd() * 0.35 : st.rnd() * 0.12) * st.volume * 255);
  return out;
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// ---------------------------------------------------------------- generated album art

function renderArt(draw: Track['art'], seed: number): string {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  draw(ctx, S, rng(seed * 101));
  grain(ctx, S, rng(seed * 7));
  return c.toDataURL('image/jpeg', 0.9);
}

function drawNeon(ctx: Ctx, S: number, r: Rng) {
  const sky = ctx.createLinearGradient(0, 0, 0, S * 0.64);
  sky.addColorStop(0, '#14062f');
  sky.addColorStop(0.55, '#4b0f63');
  sky.addColorStop(1, '#ff3d81');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.2 + r() * 0.6})`;
    ctx.fillRect(r() * S, r() * S * 0.45, 1.6, 1.6);
  }
  const sun = document.createElement('canvas');
  sun.width = sun.height = S;
  const s = sun.getContext('2d')!;
  const sg = s.createLinearGradient(0, S * 0.28, 0, S * 0.64);
  sg.addColorStop(0, '#ffe36e');
  sg.addColorStop(0.6, '#ff7a59');
  sg.addColorStop(1, '#ff2e88');
  s.fillStyle = sg;
  s.beginPath();
  s.arc(S / 2, S * 0.5, S * 0.22, 0, Math.PI * 2);
  s.fill();
  s.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 7; k++) s.fillRect(0, S * (0.5 + k * 0.026), S, 3 + k * 1.4);
  ctx.shadowColor = '#ff5fa2';
  ctx.shadowBlur = 40;
  ctx.drawImage(sun, 0, 0);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#2a0838';
  ridge(ctx, S, S * 0.6, S * 0.1, r);
  ctx.fillStyle = '#0d0320';
  ctx.fillRect(0, S * 0.64, S, S);
  ctx.strokeStyle = 'rgba(255,61,190,0.75)';
  ctx.lineWidth = 2;
  for (let k = -12; k <= 12; k++) {
    ctx.beginPath();
    ctx.moveTo(S / 2 + k * 8, S * 0.64);
    ctx.lineTo(S / 2 + k * 70, S);
    ctx.stroke();
  }
  for (let k = 1; k < 10; k++) {
    const y = S * 0.64 + Math.pow(k / 9, 2.1) * S * 0.36;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(S, y);
    ctx.stroke();
  }
}

function drawOrchard(ctx: Ctx, S: number, r: Rng) {
  const g = ctx.createRadialGradient(S * 0.3, S * 0.25, 10, S * 0.5, S * 0.5, S * 0.8);
  g.addColorStop(0, '#1f8a6b');
  g.addColorStop(1, '#05211d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'screen';
  const cols = ['#b8f25c', '#3fd6b0', '#f7e36b', '#4aa3ff', '#9cf2d8'];
  for (let i = 0; i < 26; i++) {
    const x = r() * S, y = r() * S, rad = 30 + r() * 120;
    const cg = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const col = cols[i % cols.length];
    cg.addColorStop(0, col + 'cc');
    cg.addColorStop(0.7, col + '33');
    cg.addColorStop(1, col + '00');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(S * 0.62, S * 0.58, S * 0.2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(S * 0.62, S * 0.58, S * 0.26, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(4,24,20,0.85)';
  ctx.fillRect(S * 0.08, S * 0.82, S * 0.3, 6);
}

function drawBloom(ctx: Ctx, S: number, r: Rng) {
  const g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, '#160d3d');
  g.addColorStop(0.55, '#3b1a7a');
  g.addColorStop(1, '#f2662a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.translate(S / 2, S / 2);
  for (let k = 14; k > 0; k--) {
    ctx.rotate(0.11);
    const w = k * 34;
    ctx.strokeStyle = k % 2 ? 'rgba(255,170,90,0.55)' : 'rgba(140,110,255,0.6)';
    ctx.lineWidth = 3;
    ctx.strokeRect(-w / 2, -w / 2, w, w);
  }
  ctx.restore();
  ctx.save();
  ctx.translate(S / 2, S / 2);
  ctx.globalCompositeOperation = 'lighter';
  for (let p = 0; p < 10; p++) {
    ctx.rotate((Math.PI * 2) / 10);
    const pg = ctx.createLinearGradient(0, 0, 0, -S * 0.3);
    pg.addColorStop(0, 'rgba(255,90,140,0.9)');
    pg.addColorStop(1, 'rgba(255,190,80,0.05)');
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.ellipse(0, -S * 0.15, S * 0.05, S * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = '#fff4e0';
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.035, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(255,255,255,${r() * 0.25})`;
    ctx.fillRect(r() * S, r() * S, 2, 2);
  }
}

function ridge(ctx: Ctx, S: number, base: number, amp: number, r: Rng) {
  ctx.beginPath();
  ctx.moveTo(0, base);
  for (let x = 0; x <= S; x += S / 16) ctx.lineTo(x, base - r() * amp - (x % (S / 4) === 0 ? amp * 0.6 : 0));
  ctx.lineTo(S, S);
  ctx.lineTo(0, S);
  ctx.closePath();
  ctx.fill();
}

function grain(ctx: Ctx, S: number, r: Rng) {
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 14;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
