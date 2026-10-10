/**
 * Spectrum state shared by every renderer.
 *
 * Wire frame: 35 bytes. [0..31] band level 0-255, low to high, log spaced. [32] flags, bit 0 is
 * a beat onset. [33] overall level. [34] punch: the low end's hardest hit since the last frame,
 * read from the raw samples every 5 ms. SignalR's JSON protocol sends byte[] as base64; a
 * Uint8Array, ArrayBuffer or number[] is accepted too. A 34-byte frame (an older host) has no
 * punch, and the beat flag drives `kick` instead.
 *
 * `push` only stores the frame. The shared clock calls `step`, which interpolates between the
 * last two frames and eases the shown levels, so drawing never runs faster than the clock.
 */
export const BANDS = 32;
const FRAME_MS = 1000 / 30;
const STALE_MS = 450;

// Easing of the shown levels, per second. The host already smooths each band (fast attack,
// slower release), so the page adds only enough to hide the 30 Hz steps: a rise lands within a
// frame and a fall takes about three, which keeps the bars punchy without jitter.
const RISE = 60;
const FALL = 16;
// Punch under this is the bass line moving, not a hit; the rest of the range scales to a full kick.
const PUNCH_FLOOR = 0.1;
const PUNCH_FULL = 0.7;

// Peak markers hold briefly at a new high, then fall under gravity (units of full height per s^2).
const PEAK_HOLD_S = 0.14;
const PEAK_GRAVITY = 3.2;

export class Spectrum {
  readonly prev = new Float32Array(BANDS);
  readonly cur = new Float32Array(BANDS);
  /** Eased band levels, 0-1. Every visualizer layer reads these, every clock frame. */
  readonly shown = new Float32Array(BANDS);
  /** Falling peak markers, 0-1. They follow `shown` every frame and settle to 0 without frames. */
  readonly peak = new Float32Array(BANDS);
  private readonly peakV = new Float32Array(BANDS);
  private readonly peakHold = new Float32Array(BANDS);
  at = -1e9;
  /** How hard the low end just hit, 0-1, decaying to 0. The cover bump and the flashes follow it. */
  kick = 0;
  /** Smoothed bass energy, 0-1. */
  low = 0;
  level = 0;
  levelShown = 0;
  live = false;
  /** Beat flags since the last step; renderers spawn sparks from it. */
  beats = 0;

  push(raw: unknown): boolean {
    const f = decodeFrame(raw);
    if (!f || f.length < BANDS + 1) return false;
    const now = performance.now();
    const t = Math.min(1, (now - this.at) / FRAME_MS);
    for (let b = 0; b < BANDS; b++) {
      this.prev[b] = this.prev[b] + (this.cur[b] - this.prev[b]) * t;
      this.cur[b] = f[b] / 255;
    }
    this.at = now;
    if (f[BANDS] & 1) this.beats++;
    // The punch is measured as the hit lands, so the bump moves with it. The beat flag alone was
    // late and, on a song with a steady bass line, stopped firing after the first second.
    const hit = f.length > BANDS + 2
      ? Math.min(1, Math.max(0, (f[BANDS + 2] / 255 - PUNCH_FLOOR) / (PUNCH_FULL - PUNCH_FLOOR)))
      : f[BANDS] & 1 ? 1 : 0;
    if (hit > this.kick) this.kick = hit;
    this.level = f.length > BANDS + 1 ? f[BANDS + 1] / 255 : avg(this.cur);
    return true;
  }

  private stepAt = -1;
  private moving = false;

  /** Advances the eased values. Returns true while anything is still moving. Several
   *  renderers may call it in one frame; only the first call advances. */
  step(now: number, dt: number): boolean {
    if (now === this.stepAt) return this.moving;
    this.stepAt = now;
    this.live = now - this.at < STALE_MS;
    const t = Math.min(1, (now - this.at) / FRAME_MS);
    const up = 1 - Math.exp(-dt * RISE);
    const down = 1 - Math.exp(-dt * FALL);
    let moving = this.live;
    for (let b = 0; b < BANDS; b++) {
      const target = this.live ? this.prev[b] + (this.cur[b] - this.prev[b]) * t : 0;
      const v = this.shown[b];
      const nv = v + (target - v) * (target > v ? up : down);
      this.shown[b] = nv < 0.002 ? 0 : nv;
      // The peak marker: caught up by any higher level, otherwise held a moment and dropped.
      if (this.shown[b] >= this.peak[b]) {
        this.peak[b] = this.shown[b];
        this.peakV[b] = 0;
        this.peakHold[b] = PEAK_HOLD_S;
      } else if (this.peakHold[b] > 0) {
        this.peakHold[b] -= dt;
      } else {
        this.peakV[b] += PEAK_GRAVITY * dt;
        this.peak[b] = Math.max(this.shown[b], this.peak[b] - this.peakV[b] * dt);
        if (this.peak[b] < 0.002) this.peak[b] = 0;
      }
      if (this.shown[b] > 0 || this.peak[b] > 0) moving = true;
    }
    this.kick *= Math.exp(-dt * 7);
    if (this.kick < 0.003) this.kick = 0;
    const lowTarget = this.live ? (this.shown[0] + this.shown[1] + this.shown[2] + this.shown[3]) / 4 : 0;
    this.low += (lowTarget - this.low) * (1 - Math.exp(-dt * 14));
    const lt = this.live ? this.level : 0;
    this.levelShown += (lt - this.levelShown) * (1 - Math.exp(-dt * 8));
    if (this.low < 0.002) this.low = 0;
    if (this.levelShown < 0.002) this.levelShown = 0;
    this.moving = moving || this.kick > 0 || this.low > 0 || this.levelShown > 0;
    return this.moving;
  }

  reset() {
    this.prev.fill(0);
    this.cur.fill(0);
    this.shown.fill(0);
    this.peak.fill(0);
    this.peakV.fill(0);
    this.peakHold.fill(0);
    this.kick = this.low = this.level = this.levelShown = 0;
    this.at = -1e9;
    this.beats = 0;
  }
}

export function decodeFrame(f: unknown): Uint8Array | null {
  if (!f) return null;
  if (typeof f === 'string') {
    try {
      const bin = atob(f);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    } catch {
      return null;
    }
  }
  if (f instanceof ArrayBuffer) return new Uint8Array(f);
  if (ArrayBuffer.isView(f)) return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  if (Array.isArray(f)) return Uint8Array.from(f);
  return null;
}

function avg(a: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

// ---------------------------------------------------------------- drawing

/** Three-bar mini equaliser (low, mid, high), each bar 3 px wide. */
export function drawEq(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, s: Spectrum, color: string) {
  const sh = s.shown;
  const lo = (sh[1] + sh[2] + sh[3]) / 3;
  const mid = (sh[12] + sh[14] + sh[16]) / 3;
  const hi = (sh[24] + sh[27] + sh[30]) / 3;
  ctx.fillStyle = color;
  [lo, mid, hi].forEach((v, i) => {
    const bh = Math.max(2, (0.25 + Math.min(1, v) * 0.75) * h);
    ctx.fillRect(x + i * 5, y + h - bh, 3, bh);
  });
}

// ---------------------------------------------------------------- sparks

/**
 * Small particles thrown on beats. A fixed pool, drawn additively on the spectrum canvas.
 * Each spark is clamped to `bounds`, so nothing leaves the canvas (and the canvas never leaves
 * the card).
 */
export class Sparks {
  private readonly x = new Float32Array(48);
  private readonly y = new Float32Array(48);
  private readonly vx = new Float32Array(48);
  private readonly vy = new Float32Array(48);
  private readonly life = new Float32Array(48);
  private readonly max = new Float32Array(48);
  private next = 0;
  alive = 0;

  private readonly bounds: { x: number; y: number; w: number; h: number };

  // A plain field, not a parameter property, so `npm test` (Node's type stripping) can load this file.
  constructor(bounds: { x: number; y: number; w: number; h: number }) {
    this.bounds = bounds;
  }

  spawn(x: number, y: number, angle: number, speed: number, ttl: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.x.length;
    if (this.life[i] <= 0) this.alive++;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = Math.cos(angle) * speed;
    this.vy[i] = Math.sin(angle) * speed;
    this.life[i] = ttl;
    this.max[i] = ttl;
  }

  step(dt: number) {
    if (!this.alive) return;
    const b = this.bounds;
    let alive = 0;
    for (let i = 0; i < this.x.length; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const drag = Math.exp(-dt * 2.2);
      this.vx[i] *= drag;
      this.vy[i] *= drag;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      if (this.x[i] < b.x + 2 || this.x[i] > b.x + b.w - 2 || this.y[i] < b.y + 2 || this.y[i] > b.y + b.h - 2) {
        this.life[i] = 0;
        continue;
      }
      alive++;
    }
    this.alive = alive;
  }

  draw(ctx: CanvasRenderingContext2D, core: string, halo: string) {
    if (!this.alive) return;
    ctx.globalCompositeOperation = 'lighter';
    for (let pass = 0; pass < 2; pass++) {
      ctx.fillStyle = pass === 0 ? halo : core;
      ctx.beginPath();
      for (let i = 0; i < this.x.length; i++) {
        if (this.life[i] <= 0) continue;
        const k = this.life[i] / this.max[i];
        const r = (pass === 0 ? 3.2 : 1.2) * (0.4 + k * 0.6);
        ctx.moveTo(this.x[i] + r, this.y[i]);
        ctx.arc(this.x[i], this.y[i], r, 0, Math.PI * 2);
      }
      ctx.globalAlpha = pass === 0 ? 0.35 : 0.9;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  clear() {
    this.life.fill(0);
    this.alive = 0;
  }
}
