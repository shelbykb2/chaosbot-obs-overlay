import { soundUrl } from './images';

/* Alert sounds. Four are built in and made with Web Audio, so nothing ships as a file; a streamer's
   own sound is a stored file (OverlaySoundStore) played with an Audio element. In OBS the browser
   source needs "Control audio via OBS" on for the sound to reach the stream mix. */

export const BUILT_IN = ['chime', 'pop', 'coin', 'whoosh'] as const;
export type BuiltIn = (typeof BUILT_IN)[number];


let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(c: AudioContext, at: number, freq: number, dur: number, type: OscillatorType, gain: number, out: AudioNode, glide?: number) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + dur + 0.02);
}

function playBuiltIn(name: BuiltIn, volume: number) {
  const c = audio();
  if (!c) return;
  const out = c.createGain();
  out.gain.value = Math.max(0, Math.min(1, volume));
  out.connect(c.destination);
  const t = c.currentTime + 0.01;
  if (name === 'chime') {
    tone(c, t, 880, 0.9, 'sine', 0.35, out);
    tone(c, t + 0.12, 1318.5, 1.1, 'sine', 0.3, out);
    tone(c, t + 0.24, 1760, 1.3, 'sine', 0.22, out);
  } else if (name === 'pop') {
    tone(c, t, 420, 0.16, 'sine', 0.6, out, 900);
    tone(c, t + 0.1, 660, 0.18, 'triangle', 0.35, out, 1200);
  } else if (name === 'coin') {
    tone(c, t, 988, 0.09, 'square', 0.16, out);
    tone(c, t + 0.08, 1319, 0.5, 'square', 0.16, out);
  } else {
    // A short noise sweep.
    const len = Math.floor(c.sampleRate * 0.6);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(4000, t + 0.5);
    const g = c.createGain();
    g.gain.value = 0.5;
    src.connect(f).connect(g).connect(out);
    src.start(t);
  }
}

/** Plays an alert's sound: a built-in name, or 'custom' with a stored file, or nothing. */
export function playSound(sound: unknown, file: unknown, volume: number, live: boolean) {
  if (BUILT_IN.includes(sound as BuiltIn)) {
    playBuiltIn(sound as BuiltIn, volume);
    return;
  }
  const src = sound === 'custom' ? soundUrl(file, live) : null;
  if (!src) return;
  try {
    const a = new Audio(src);
    a.volume = Math.max(0, Math.min(1, volume));
    void a.play().catch(() => {});
  } catch {
    // No audio here; the alert still shows.
  }
}
