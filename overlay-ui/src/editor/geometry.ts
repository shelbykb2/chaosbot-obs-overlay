/* Pure canvas maths for the editor: clamping, snapping, moving and resizing boxes on the
   1920 x 1080 canvas. No imports, so `npm test` runs it straight under Node. */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Guide {
  axis: 'x' | 'y';
  at: number;
}

export type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const W = 1920;
export const H = 1080;

/** Whole pixels, at least `minW` x `minH`, fully on the canvas. */
export function clampBox(r: Box, minW = 8, minH = minW): Box {
  const w = Math.max(minW, Math.min(W, Math.round(r.w)));
  const h = Math.max(minH, Math.min(H, Math.round(r.h)));
  return {
    x: Math.round(Math.min(W - w, Math.max(0, r.x))),
    y: Math.round(Math.min(H - h, Math.max(0, r.y))),
    w,
    h,
  };
}

export function bounds(rects: Box[]): Box {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const r = Math.max(...rects.map((q) => q.x + q.w));
  const b = Math.max(...rects.map((q) => q.y + q.h));
  return { x, y, w: r - x, h: b - y };
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Lines a box can snap to: the canvas edges and centre, and the edges and centres of `others`. */
export function snapTargets(others: Box[]): { xs: number[]; ys: number[] } {
  const xs = [0, W / 2, W];
  const ys = [0, H / 2, H];
  for (const r of others) {
    xs.push(r.x, r.x + r.w / 2, r.x + r.w);
    ys.push(r.y, r.y + r.h / 2, r.y + r.h);
  }
  return { xs, ys };
}

/** The nearest snap of any of `mine` to any of `targets` within `thr`, as a shift and the line. */
export function bestSnap(mine: number[], targets: number[], thr: number): { d: number; at: number } | null {
  let best: { d: number; at: number } | null = null;
  for (const m of mine) {
    for (const t of targets) {
      const d = t - m;
      if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
    }
  }
  return best;
}

/**
 * The shift for a group whose bounds started at `b0`, dragged by (`dx`, `dy`). Snaps the group's
 * edges and centre lines within `thr` when `snap` is on, then keeps the group on the canvas.
 */
export function moveDelta(
  b0: Box,
  dx: number,
  dy: number,
  targets: { xs: number[]; ys: number[] } | null,
  thr: number,
): { dx: number; dy: number; guides: Guide[] } {
  const guides: Guide[] = [];
  if (targets) {
    const bx = bestSnap([b0.x + dx, b0.x + dx + b0.w / 2, b0.x + dx + b0.w], targets.xs, thr);
    const by = bestSnap([b0.y + dy, b0.y + dy + b0.h / 2, b0.y + dy + b0.h], targets.ys, thr);
    if (bx) {
      dx += bx.d;
      guides.push({ axis: 'x', at: bx.at });
    }
    if (by) {
      dy += by.d;
      guides.push({ axis: 'y', at: by.at });
    }
  }
  dx = Math.round(Math.max(-b0.x, Math.min(W - b0.x - b0.w, dx)));
  dy = Math.round(Math.max(-b0.y, Math.min(H - b0.y - b0.h, dy)));
  return { dx, dy, guides };
}

/**
 * `r0` resized from handle `dir` by (`dx`, `dy`). The dragged edges snap within `thr`; `aspect`
 * (width over height) keeps the shape, and then nothing snaps. The result stays at least
 * `minW` x `minH` and on the canvas, with the opposite edge held still.
 */
export function resizeBox(
  r0: Box,
  dir: Dir,
  dx: number,
  dy: number,
  opts: { targets: { xs: number[]; ys: number[] } | null; thr: number; aspect: number | null; minW: number; minH: number },
): { rect: Box; guides: Guide[] } {
  const { targets, thr, aspect, minW, minH } = opts;
  const guides: Guide[] = [];
  let left = r0.x;
  let top = r0.y;
  let right = r0.x + r0.w;
  let bottom = r0.y + r0.h;
  const snap = (v: number, axis: 'x' | 'y') => {
    if (!targets || aspect) return v;
    const s = bestSnap([v], axis === 'x' ? targets.xs : targets.ys, thr);
    if (!s) return v;
    guides.push({ axis, at: s.at });
    return v + s.d;
  };
  if (dir.includes('e')) right = snap(Math.min(W, right + dx), 'x');
  if (dir.includes('w')) left = snap(Math.max(0, left + dx), 'x');
  if (dir.includes('s')) bottom = snap(Math.min(H, bottom + dy), 'y');
  if (dir.includes('n')) top = snap(Math.max(0, top + dy), 'y');
  let w = Math.max(minW, right - left);
  let h = Math.max(minH, bottom - top);
  if (aspect) {
    if (dir === 'n' || dir === 's') w = h * aspect;
    else if (dir === 'e' || dir === 'w') h = w / aspect;
    else if (w / h > aspect) h = w / aspect;
    else w = h * aspect;
    // Shrink back onto the canvas without losing the shape.
    const maxW = dir.includes('w') ? r0.x + r0.w : W - r0.x;
    const maxH = dir.includes('n') ? r0.y + r0.h : H - r0.y;
    const k = Math.min(1, maxW / w, maxH / h);
    w *= k;
    h *= k;
  }
  const x = dir.includes('w') ? r0.x + r0.w - w : r0.x;
  const y = dir.includes('n') ? r0.y + r0.h - h : r0.y;
  return { rect: clampBox({ x, y, w, h }, minW, minH), guides };
}

/** The box dragged out from `a` to `b`, on the canvas. */
export function dragBox(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  const x0 = Math.max(0, Math.min(W, Math.min(a.x, b.x)));
  const y0 = Math.max(0, Math.min(H, Math.min(a.y, b.y)));
  const x1 = Math.max(0, Math.min(W, Math.max(a.x, b.x)));
  const y1 = Math.max(0, Math.min(H, Math.max(a.y, b.y)));
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}
