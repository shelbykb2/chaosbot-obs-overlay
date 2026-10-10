/**
 * Colours and pre-blurred backdrops taken from cover art, once per track.
 *
 * Everything here runs when a track changes and never per frame. The blurred bitmaps replace
 * any live blur: OBS has nothing behind a transparent page to blur, and a live
 * backdrop-filter or animated filter costs GPU time on every frame.
 */
export type Rgb = [number, number, number];

export interface Palette {
  /** CSS-ready "r, g, b" strings and rgb() colours. */
  domRgb: string;
  darkRgb: string;
  vib: string;
  vibHi: string;
  vibRgb: Rgb;
  vibHiRgb: Rgb;
  /** Tint strength for white text over the art. Brighter art gets more. */
  scrim: number;
  /** Pre-blurred art for the "art" backdrop (rich, saturated). */
  artUrl: string | null;
  /** Pre-blurred art for the "glass" backdrop (softer and paler, like light through frost). */
  glassUrl: string | null;
}

const FALLBACK: Rgb = [148, 85, 255];

export function fallbackPalette(): Palette {
  return paletteFrom(FALLBACK, FALLBACK, 0.35, null, null);
}

/** Palette from an image that has already decoded. The image must be same-origin. */
export function extractPalette(img: HTMLImageElement): Palette {
  const N = 40;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, N, N);
    data = ctx.getImageData(0, 0, N, N).data;
  } catch {
    return fallbackPalette(); // tainted canvas: the art was not same-origin
  }
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let lumSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let k = buckets.get(key);
    if (!k) buckets.set(key, (k = { n: 0, r: 0, g: 0, b: 0 }));
    k.n++;
    k.r += r;
    k.g += g;
    k.b += b;
  }
  let dom: Rgb | null = null, domScore = -1, vib: Rgb | null = null, vibScore = -1;
  for (const k of buckets.values()) {
    const rgb: Rgb = [k.r / k.n, k.g / k.n, k.b / k.n];
    const [, s, l] = rgbToHsl(rgb);
    const ds = k.n * (0.35 + s) * (l > 0.06 && l < 0.94 ? 1 : 0.2);
    if (ds > domScore) {
      domScore = ds;
      dom = rgb;
    }
    const vs = k.n * Math.pow(s, 1.6) * Math.max(0, 1 - Math.abs(l - 0.55) * 1.7);
    if (vs > vibScore) {
      vibScore = vs;
      vib = rgb;
    }
  }
  const d = dom ?? FALLBACK;
  return paletteFrom(
    d,
    vibScore > 0 && vib ? vib : d,
    lumSum / (N * N),
    blurred(img, 12, 'blur(10px) saturate(1.35)'),
    blurred(img, 6, 'blur(16px) saturate(1.1) brightness(1.15)'),
  );
}

/** A fixed accent replaces the colours from the art; the blurred art stays. */
export function withAccent(p: Palette, hex: string | null): Palette {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return p;
  const n = parseInt(hex.slice(1), 16);
  const rgb: Rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const fixed = paletteFrom(rgb, rgb, 0.35, p.artUrl, p.glassUrl);
  return { ...fixed, scrim: p.scrim };
}

function paletteFrom(dom: Rgb, vib: Rgb, avgLum: number, artUrl: string | null, glassUrl: string | null): Palette {
  const [hd, sd] = rgbToHsl(dom);
  const [hv, sv] = rgbToHsl(vib);
  const dark = hslToRgb([hd, Math.min(sd * 0.85, 0.6), 0.11]);
  const v = hslToRgb([hv, clamp(sv, 0.5, 0.95), 0.62]);
  const vHi = hslToRgb([hv, clamp(sv, 0.45, 0.9), 0.84]);
  return {
    domRgb: css(dom),
    darkRgb: css(dark),
    vib: `rgb(${css(v)})`,
    vibHi: `rgb(${css(vHi)})`,
    vibRgb: v.map(Math.round) as Rgb,
    vibHiRgb: vHi.map(Math.round) as Rgb,
    scrim: clamp(0.6 + avgLum * 0.3, 0.6, 0.86),
    artUrl,
    glassUrl,
  };
}

/** CSS custom properties for a palette, for a style attribute. */
export function paletteVars(p: Palette): Record<string, string> {
  return {
    '--sp-dom-rgb': p.domRgb,
    '--sp-dark-rgb': p.darkRgb,
    '--sp-vib': p.vib,
    '--sp-vib-hi': p.vibHi,
    '--sp-vib-rgb': p.vibRgb.join(', '),
    '--sp-scrim': p.scrim.toFixed(3),
    '--sp-art-url': p.artUrl ? `url("${p.artUrl}")` : 'none',
    '--sp-glass-url': p.glassUrl ? `url("${p.glassUrl}")` : 'none',
  };
}

// Downscale to a few pixels, then draw back up through a blur: a smooth wash of the art's
// colours that costs one small JPEG per track.
function blurred(img: HTMLImageElement, cells: number, filter: string): string | null {
  try {
    const small = document.createElement('canvas');
    small.width = small.height = cells;
    small.getContext('2d')!.drawImage(img, 0, 0, cells, cells);
    const big = document.createElement('canvas');
    big.width = big.height = 200;
    const x = big.getContext('2d')!;
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    if ('filter' in x) x.filter = filter;
    x.drawImage(small, -30, -30, 260, 260);
    return big.toDataURL('image/jpeg', 0.86);
  } catch {
    return null;
  }
}

export function rgbToHsl([r, g, b]: Rgb): Rgb {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb([h, s, l]: Rgb): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

const css = (rgb: Rgb) => rgb.map(Math.round).join(', ');
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
