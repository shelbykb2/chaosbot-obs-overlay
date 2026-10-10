import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

/** A rect in canvas fractions (0-1), the same units as OverlayZone. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function clampRect(r: Partial<Rect>): Rect {
  const c = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const x = c(r.x, 0, 1, 0);
  const y = c(r.y, 0, 1, 0);
  return { x, y, w: c(r.w, 0.01, 1 - x, 0.01), h: c(r.h, 0.01, 1 - y, 0.01) };
}

/** A piece's layout box in design pixels. With `minW`/`maxW` the width stretches to the rect. */
export interface Design {
  w: number;
  h: number;
  minW?: number;
  maxW?: number;
}

const FitContext = createContext({ scale: 1, w: 0 });

/** The scale the design box is drawn at, for canvases that size their bitmap to it. */
export function useFitScale() {
  return useContext(FitContext).scale;
}

/** The layout width in design pixels (the design width, or the stretched one). */
export function useFitWidth() {
  return useContext(FitContext).w;
}

/**
 * Scale and layout width for a design box in a rect of `rw` x `rh` screen pixels.
 *
 * A fixed design scales to fit and keeps its aspect. A stretchable one fills the rect's height
 * and widens (or narrows) its layout to the rect's width, inside `minW`..`maxW`; past those it
 * keeps the limit and sits against the nearer screen edge.
 */
export function fitDesign(design: Design, rw: number, rh: number): { scale: number; w: number } {
  if (!design.minW || !design.maxW) return { scale: Math.min(rw / design.w, rh / design.h), w: design.w };
  const sh = rh / design.h;
  const w = rw / sh;
  if (w < design.minW) return { scale: rw / design.minW, w: design.minW };
  return { scale: sh, w: Math.min(w, design.maxW) };
}

/** A stage size in screen pixels. */
export interface Stage {
  w: number;
  h: number;
}

/**
 * The box a Region's rect fractions are taken of. OBS pages leave it unset and use the window;
 * the overlay editor draws pieces on a 1920 x 1080 stage inside a bigger page, so it provides the
 * stage size here and the pieces lay out exactly as OBS would draw them.
 */
export const StageContext = createContext<Stage | null>(null);

function viewport(): Stage {
  return { w: window.innerWidth, h: window.innerHeight };
}

/** The stage size: the provided one, or the window (tracked while no stage is provided). */
function useStage(): Stage {
  const stage = useContext(StageContext);
  const [vp, setVp] = useState(viewport);
  useEffect(() => {
    if (stage) return;
    const on = () => setVp(viewport());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [stage === null]);
  return stage ?? vp;
}

/**
 * Places a piece in its configured rect.
 *
 * The piece is laid out in fixed design pixels (`design`), then scaled to fit the rect and
 * pushed against the rect edge nearest the screen edge. The rect clips (overflow: hidden): it
 * is the area other overlay pieces keep out of, so nothing a piece draws, glows included, may
 * land outside it.
 */
export function Region(props: {
  rect: Rect;
  design: Design;
  opacity?: number;
  className?: string;
  children: ComponentChildren;
}) {
  const vp = useStage();
  const { rect, design } = props;
  const rw = rect.w * vp.w;
  const rh = rect.h * vp.h;
  const fit = fitDesign(design, rw, rh);
  const s = fit.scale;
  const ox = rect.x + rect.w / 2 < 0.5 ? 0 : rw - fit.w * s;
  const oy = rect.y + rect.h / 2 < 0.5 ? 0 : rh - design.h * s;

  return (
    <div
      class={'ov-region' + (props.className ? ' ' + props.className : '')}
      style={{
        left: rect.x * 100 + '%',
        top: rect.y * 100 + '%',
        width: rect.w * 100 + '%',
        height: rect.h * 100 + '%',
      }}
    >
      <div
        class="ov-fit"
        style={{
          width: fit.w + 'px',
          height: design.h + 'px',
          transform: `translate(${ox}px, ${oy}px) scale(${s})`,
          opacity: props.opacity ?? 1,
          // Layout width for the piece's CSS (calc(var(--fit-w) - ...)).
          ['--fit-w' as any]: fit.w + 'px',
        }}
      >
        <FitContext.Provider value={fit}>{props.children}</FitContext.Provider>
      </div>
    </div>
  );
}

/**
 * A 2D canvas whose bitmap matches its on-screen size: `w` x `h` design pixels times the fit
 * scale and the device pixel ratio. Returns a callback ref for the element, the element itself
 * (null while none is mounted) and the context ref (already transformed to design pixels).
 *
 * The element is tracked, not only the size: a canvas that leaves the page and comes back (the
 * `none` visualizer and back) is a new element at the same size, and drawing into the old
 * one's context paints nothing anyone sees.
 */
export function useCanvas2d(w: number, h: number) {
  const scale = useFitScale();
  const [el, ref] = useState<HTMLCanvasElement | null>(null);
  const ctx = useRef<CanvasRenderingContext2D | null>(null);
  useLayoutEffect(() => {
    if (!el) {
      ctx.current = null;
      return;
    }
    const k = scale * (window.devicePixelRatio || 1);
    el.width = Math.max(1, Math.round(w * k));
    el.height = Math.max(1, Math.round(h * k));
    const x = el.getContext('2d');
    if (x) x.setTransform(el.width / w, 0, 0, el.height / h, 0, 0);
    ctx.current = x;
  }, [el, w, h, scale]);
  return { ref, el, ctx };
}
