import { BANDS, type Spectrum } from './spectrum';

/**
 * The music visualizers, drawn on the card's one canvas by the shared 30 fps clock.
 *
 * Every layer of every style reads the spectrum's eased levels (`shown`, `peak`, `kick`) on
 * every frame it draws. Nothing is kept from an earlier frame, so when the levels fall (a
 * quieter passage, a lower volume, or no frames at all after a pause) everything falls with them
 * and settles at rest.
 *
 * Strip styles fill a rectangle: classic bars, mirrored bars, LED dots, a filled wave. The ring
 * hugs the album art: a circle for round art, the outline of a rounded square for square art.
 * The beat flag drives a short flash and swell on every style.
 */
export type VisualizerKind = 'bars' | 'mirror' | 'dots' | 'wave' | 'ring' | 'none';
/** `auto` is each card style's own look: bars on the card, the ring on the pill and the vinyl. */
export type VisualizerSetting = VisualizerKind | 'auto';

export const VISUALIZERS: readonly VisualizerSetting[] = ['auto', 'bars', 'mirror', 'dots', 'wave', 'ring', 'none'];

export function normaliseVisualizer(v: unknown): VisualizerSetting {
  return typeof v === 'string' && (VISUALIZERS as readonly string[]).includes(v) ? (v as VisualizerSetting) : 'auto';
}

export function resolveVisualizer(v: VisualizerSetting, style: string): VisualizerKind {
  if (v !== 'auto') return v;
  return style === 'card' ? 'bars' : 'ring';
}

export interface VizColors {
  vib: string;
  vibHi: string;
  /** "r, g, b" */
  vibRgb: string;
  vibHiRgb: string;
  domRgb: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Shaping from band level (0-1) to drawn height: a little expansion, so loud parts reach the
 *  top and quiet parts sit low, instead of everything hovering mid-height. */
const lift = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, 1.25));

/** Level of a fractional band position, linearly between neighbours. */
function sample(a: Float32Array, pos: number) {
  const i = Math.max(0, Math.min(BANDS - 1, pos));
  const lo = Math.floor(i);
  const hi = Math.min(BANDS - 1, lo + 1);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

/**
 * Caches gradients per box and palette, so a frame allocates nothing. One per canvas.
 */
export class VizPainter {
  private key = '';
  private grads: Record<string, CanvasGradient> = {};

  private gradient(ctx: CanvasRenderingContext2D, name: string, make: () => CanvasGradient) {
    return (this.grads[name] ??= make());
  }

  /** Forget cached gradients when the colours or the box change. */
  sync(key: string) {
    if (key !== this.key) {
      this.key = key;
      this.grads = {};
    }
  }

  /**
   * Draws a strip style in `box`. `alpha` dims the whole thing (ambient use behind text).
   */
  strip(ctx: CanvasRenderingContext2D, kind: VisualizerKind, box: Box, s: Spectrum, c: VizColors, alpha = 1) {
    if (alpha < 1) ctx.globalAlpha = alpha;
    if (kind === 'bars') this.bars(ctx, box, s, c);
    else if (kind === 'mirror') this.mirror(ctx, box, s, c);
    else if (kind === 'dots') this.dots(ctx, box, s, c);
    else if (kind === 'wave') this.wave(ctx, box, s, c);
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------ classic bars

  private bars(ctx: CanvasRenderingContext2D, b: Box, s: Spectrum, c: VizColors) {
    const n = BANDS;
    const gap = Math.max(2, Math.round(b.w / n / 4));
    const bw = (b.w - gap * (n - 1)) / n;
    const r = Math.min(3, bw / 2);
    const g = this.gradient(ctx, 'bars', () => {
      const gr = ctx.createLinearGradient(0, b.y + b.h, 0, b.y);
      gr.addColorStop(0, `rgba(${c.domRgb}, 0.75)`);
      gr.addColorStop(0.4, c.vib);
      gr.addColorStop(1, c.vibHi);
      return gr;
    });
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = lift(s.shown[i]);
      const h = Math.max(2, v * b.h);
      roundTop(ctx, b.x + i * (bw + gap), b.y + b.h - h, bw, h, r);
    }
    ctx.fillStyle = g;
    ctx.fill();
    // The beat: the bars flash towards white, strongest at the top.
    if (s.kick > 0.02) {
      ctx.globalAlpha *= s.kick * 0.45;
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.globalAlpha /= s.kick * 0.45;
    }
    // Peak caps fall under gravity a moment after each high.
    ctx.fillStyle = `rgba(${c.vibHiRgb}, 0.95)`;
    for (let i = 0; i < n; i++) {
      const pk = lift(s.peak[i]);
      if (pk < 0.04) continue;
      ctx.fillRect(b.x + i * (bw + gap), b.y + b.h - pk * b.h - 1, bw, 2);
    }
  }

  // ------------------------------------------------------------ mirrored, centre out

  /** Bass in the middle, treble at both ends, each bar reaching up and down from the centre line. */
  private mirror(ctx: CanvasRenderingContext2D, b: Box, s: Spectrum, c: VizColors) {
    const side = 24;
    const n = side * 2;
    const gap = Math.max(2, Math.round(b.w / n / 3.2));
    const bw = (b.w - gap * (n - 1)) / n;
    const mid = b.y + b.h / 2;
    const half = b.h / 2;
    const g = this.gradient(ctx, 'mirror', () => {
      const gr = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
      gr.addColorStop(0, `rgba(${c.vibRgb}, 0.55)`);
      gr.addColorStop(0.5, c.vibHi);
      gr.addColorStop(1, `rgba(${c.vibRgb}, 0.55)`);
      return gr;
    });
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const fromMid = k < side ? side - 1 - k : k - side; // 0 at the centre
      const v = lift(sample(s.shown, (fromMid / (side - 1)) * (BANDS - 1)));
      const h = Math.max(1, v * half);
      const x = b.x + k * (bw + gap);
      roundRect(ctx, x, mid - h, bw, h * 2, Math.min(bw / 2, h));
    }
    ctx.fillStyle = g;
    ctx.fill();
    if (s.kick > 0.02) {
      ctx.globalAlpha *= s.kick * 0.5;
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.globalAlpha /= s.kick * 0.5;
    }
    // The centre line swells on the beat.
    const lw = 1 + s.kick * 2;
    ctx.fillStyle = `rgba(${c.vibHiRgb}, ${(0.35 + s.kick * 0.5).toFixed(3)})`;
    ctx.fillRect(b.x, mid - lw / 2, b.w, lw);
  }

  // ------------------------------------------------------------ LED dot columns

  private dots(ctx: CanvasRenderingContext2D, b: Box, s: Spectrum, c: VizColors) {
    const pitch = b.h < 40 ? 5 : b.h < 90 ? 7 : 9;
    const rows = Math.max(3, Math.floor(b.h / pitch));
    const cols = Math.max(8, Math.min(BANDS, Math.floor(b.w / pitch)));
    const cw = b.w / cols;
    const rad = Math.min(cw, pitch) * 0.34;
    const y0 = b.y + b.h - pitch / 2;
    // Unlit grid, faint: the meter's face. It never changes, so it is not a level.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.beginPath();
    for (let x = 0; x < cols; x++) {
      const cx = b.x + cw * (x + 0.5);
      for (let y = 0; y < rows; y++) dot(ctx, cx, y0 - y * pitch, rad);
    }
    ctx.fill();
    // Lit dots in three bands of colour, low to high, then the peak dot.
    const colsLit = new Array<number>(cols);
    for (let x = 0; x < cols; x++) colsLit[x] = Math.round(lift(sample(s.shown, (x / (cols - 1)) * (BANDS - 1))) * rows);
    const tiers: [number, number, string][] = [
      [0, 0.55, `rgba(${c.vibRgb}, 0.85)`],
      [0.55, 0.85, c.vibHi],
      [0.85, 1.01, '#fff'],
    ];
    const boost = 1 + s.kick * 0.25;
    for (const [lo, hi, col] of tiers) {
      ctx.fillStyle = col;
      ctx.beginPath();
      for (let x = 0; x < cols; x++) {
        const lit = colsLit[x];
        const cx = b.x + cw * (x + 0.5);
        for (let y = Math.floor(lo * rows); y < Math.min(lit, Math.ceil(hi * rows)); y++) dot(ctx, cx, y0 - y * pitch, rad * boost);
      }
      ctx.fill();
    }
    ctx.fillStyle = c.vibHi;
    ctx.beginPath();
    for (let x = 0; x < cols; x++) {
      const pk = Math.round(lift(sample(s.peak, (x / (cols - 1)) * (BANDS - 1))) * rows) - 1;
      if (pk < 1 || pk < colsLit[x]) continue;
      dot(ctx, b.x + cw * (x + 0.5), y0 - Math.min(rows - 1, pk) * pitch, rad);
    }
    ctx.fill();
  }

  // ------------------------------------------------------------ smooth filled wave

  private wave(ctx: CanvasRenderingContext2D, b: Box, s: Spectrum, c: VizColors) {
    const n = 40;
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    const base = b.y + b.h;
    const room = b.h - 3;
    for (let i = 0; i < n; i++) {
      xs[i] = b.x + (i / (n - 1)) * b.w;
      // Taper both ends to the baseline so the shape reads as one wave, not a cut-off graph.
      const taper = Math.min(1, Math.sin((i / (n - 1)) * Math.PI) * 2.4);
      ys[i] = base - 1.5 - lift(sample(s.shown, (i / (n - 1)) * (BANDS - 1))) * room * taper;
    }
    const fill = this.gradient(ctx, 'waveFill', () => {
      const gr = ctx.createLinearGradient(0, b.y, 0, base);
      gr.addColorStop(0, `rgba(${c.vibRgb}, 0.75)`);
      gr.addColorStop(1, `rgba(${c.vibRgb}, 0.05)`);
      return gr;
    });
    ctx.beginPath();
    ctx.moveTo(xs[0], base);
    ctx.lineTo(xs[0], ys[0]);
    curve(ctx, xs, ys);
    ctx.lineTo(xs[n - 1], base);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    // The crest: a soft wide stroke under a crisp one. The beat widens and brightens it.
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    curve(ctx, xs, ys);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(${c.vibHiRgb}, ${(0.18 + s.kick * 0.3).toFixed(3)})`;
    ctx.lineWidth = 5 + s.kick * 5;
    ctx.stroke();
    ctx.strokeStyle = s.kick > 0.5 ? '#fff' : c.vibHi;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ------------------------------------------------------------ ring around the art

  /**
   * Spokes around a circle (round art) or a rounded square (square art), 64 of them mirrored
   * left and right: bass at the bottom, treble meeting at the top. Every spoke ends within
   * `len` of the art's edge plus `gap`, so the caller sizes it to its box. The beat pushes the
   * whole ring outwards and lights the tips.
   */
  ring(
    ctx: CanvasRenderingContext2D, cx: number, cy: number, half: number, corner: number, gap: number, len: number,
    width: number, s: Spectrum, c: VizColors,
  ) {
    const n = BANDS * 2;
    const round = corner >= half;
    ctx.lineCap = 'round';
    ctx.lineWidth = width;
    const reach = len - width / 2 - 2; // round caps add half a width; 2 px for the beat swell
    const swell = s.kick * 2;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? c.vib : s.kick > 0.45 ? '#fff' : c.vibHi;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const band = k < BANDS ? k : n - 1 - k;
        const v = 0.06 + lift(s.shown[band]) * 0.94;
        const a = Math.PI / 2 + ((k + 0.5) * Math.PI * 2) / n; // start at the bottom
        const co = Math.cos(a), sn = Math.sin(a);
        const edge = round ? half : squareEdge(co, sn, half, corner);
        const r1 = edge + gap + width / 2 + swell;
        const full = r1 + v * reach;
        const split = r1 + (full - r1) * 0.55;
        const from = pass === 0 ? r1 : split;
        const to = pass === 0 ? split : full;
        if (to - from < 0.3) continue;
        ctx.moveTo(cx + co * from, cy + sn * from);
        ctx.lineTo(cx + co * to, cy + sn * to);
      }
      ctx.stroke();
    }
  }
}

/** Distance from the centre to a rounded square's edge along a direction. */
function squareEdge(co: number, sn: number, half: number, corner: number) {
  const ac = Math.abs(co), as = Math.abs(sn);
  const flat = half / Math.max(ac, as);
  // Inside the corner region, the edge is an arc of radius `corner` centred at (half - corner).
  const k = half - corner;
  const px = ac * flat, py = as * flat;
  if (px <= k || py <= k) return flat;
  // Ray-circle intersection: |t*(ac, as) - (k, k)| = corner.
  const bq = ac * k + as * k;
  const cq = 2 * k * k - corner * corner;
  return bq + Math.sqrt(Math.max(0, bq * bq - cq));
}

function curve(ctx: CanvasRenderingContext2D, xs: Float32Array, ys: Float32Array) {
  // Midpoint quadratic smoothing: passes near every point, no overshoot below the baseline.
  const n = xs.length;
  for (let i = 1; i < n - 1; i++) {
    const mx = (xs[i] + xs[i + 1]) / 2;
    const my = (ys[i] + ys[i + 1]) / 2;
    ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
  }
  ctx.lineTo(xs[n - 1], ys[n - 1]);
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function roundTop(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, h);
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
