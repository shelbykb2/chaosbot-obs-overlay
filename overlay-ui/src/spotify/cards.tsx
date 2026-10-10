import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { Backdrop, type BackdropMode } from '../shared/Backdrop';
import { clock, useClock } from '../shared/clock';
import { Marquee } from '../shared/Marquee';
import { ease, playEnter, playExit, slideIn, type EnterPart } from '../shared/motion';
import { paletteVars, type Palette } from '../shared/palette';
import { Progress, type Anchor } from '../shared/Progress';
import { LoopDriver } from '../shared/loops';
import { useCanvas2d, useFitWidth } from '../shared/Region';
import { drawEq, Sparks, Spectrum } from '../shared/spectrum';
import { VizPainter, type Box, type VisualizerKind, type VizColors } from '../shared/visualizers';
import type { CardStyle, NowPlaying } from './types';

export interface CardProps {
  np: NowPlaying;
  palette: Palette;
  anchor: Anchor;
  backdrop: BackdropMode;
  /** The light sweeping across the album cover. */
  sheen: boolean;
  spectrum: Spectrum;
  /** Playing, visible and motion allowed: loops run and spectrum frames arrive. */
  live: boolean;
  /** On the page, visible and motion allowed: the clock may tick, so the music drawing can
   *  settle to rest after the frames stop (a pause), and then the clock stops. */
  run: boolean;
  /** The music drawing, already resolved from `auto`. */
  viz: VisualizerKind;
  reduced: boolean;
  /** Leaving: the pause grace ran out, playback stopped, or a newer track replaced it. */
  leaving: boolean;
  onGone: () => void;
}

// ---------------------------------------------------------------- shared frame

/** Writes a style only when its text changes, so a resting value costs no style work. */
function setter() {
  const last = new WeakMap<HTMLElement, Record<string, string>>();
  return (el: HTMLElement | null, prop: 'transform' | 'opacity', v: string) => {
    if (!el) return;
    let m = last.get(el);
    if (!m) last.set(el, (m = {}));
    if (m[prop] === v) return;
    m[prop] = v;
    el.style[prop] = v;
  };
}

function CardFrame(props: CardProps & {
  style: CardStyle;
  parts: () => EnterPart[];
  rootRef: RefObject<HTMLDivElement | null>;
  glowRef: RefObject<HTMLDivElement | null>;
  children: ComponentChildren;
}) {
  const { palette, reduced, leaving, onGone, rootRef } = props;
  const vars = useMemo(() => paletteVars(palette), [palette]);

  useLayoutEffect(() => {
    playEnter(rootRef.current, props.parts(), reduced);
  }, []);

  useLayoutEffect(() => {
    if (!leaving) return;
    let alive = true;
    const a = playExit(rootRef.current, reduced, () => alive && onGone());
    return () => {
      alive = false;
      a?.cancel();
    };
  }, [leaving]);

  const cls =
    `sp-card sp-card--${props.style} sp-viz--${props.viz}` +
    (props.live ? ' is-live' : '') +
    (props.anchor.playing ? ' is-playing' : ' is-paused');
  return (
    <div class={cls} style={vars} ref={rootRef}>
      <div class="ov-glow" ref={props.glowRef} />
      <Backdrop mode={props.backdrop} />
      {props.children}
    </div>
  );
}

function Art(props: { url: string | null; round?: boolean; sheen?: boolean; sheenPath?: SheenPath | null }) {
  const path = props.sheenPath;
  return (
    <div class={'sp-art' + (props.round ? ' sp-art--round' : '')}>
      {props.url && <img src={props.url} alt="" decoding="async" crossOrigin="anonymous" />}
      {props.sheen && (
        <div
          class={'sp-art-sheen' + (path ? ' sp-art-sheen--sync' : '')}
          style={path ? { '--sheen-from': `${path.from}px`, '--sheen-to': `${path.to}px` } : undefined}
        />
      )}
    </div>
  );
}

interface SheenPath {
  from: number;
  to: number;
}

/**
 * Where the cover's light travels so it is the glass sweep (.bd-sweep i) passing over the cover.
 * The band is 26% of the box wide and slides from -120% to 520% of its own width; its centre at
 * travel p is (0.26 p + 0.13) of the box. The cover's light is the sheen layer's stripe, 72 px into
 * the layer at rest, and the cover sits 20 px into the box. Same keyframe timing and easing, so a
 * straight mapping of the band's path lines the two up all the way across.
 */
function cardSheenPath(boxW: number, artX: number): SheenPath {
  const at = (p: number) => Math.round((0.26 * p + 0.13) * boxW - artX - 72);
  return { from: at(-1.2), to: at(5.2) };
}

function vizColors(p: Palette): VizColors {
  return { vib: p.vib, vibHi: p.vibHi, vibRgb: p.vibRgb.join(', '), vibHiRgb: p.vibHiRgb.join(', '), domRgb: p.domRgb };
}

/**
 * The card's one clock subscription. While the card is live the CSS loops advance and the
 * canvas draws every frame the music moves. When it stops being live (a pause) the clock keeps
 * ticking only until the drawing has settled to rest, draws that rest state once, and then
 * reports nothing left to do, so the clock stops.
 */
function useCardTick(
  p: CardProps,
  o: {
    root: RefObject<HTMLDivElement | null>;
    ctx: RefObject<CanvasRenderingContext2D | null>;
    /** The mounted canvas: a new one is blank too. */
    canvas: HTMLCanvasElement | null;
    size: { w: number; h: number };
    sparks: Sparks;
    draw: (ctx: CanvasRenderingContext2D, s: Spectrum) => void;
    onBeat: () => void;
    styles: (s: Spectrum) => void;
  },
) {
  const loops = useMemo(() => new LoopDriver(() => o.root.current), []);
  const seen = useRef({ beats: p.spectrum.beats, dirty: true }).current;
  // A resized (or new) canvas is blank: draw it again on the next frame.
  useLayoutEffect(() => {
    seen.dirty = true;
    clock.wake();
  }, [o.canvas, o.size.w, o.size.h, p.viz, p.palette]);
  useClock(
    p.run && !p.leaving
      ? (now, dt) => {
          const s = p.spectrum;
          if (p.live) loops.tick(now, dt);
          const moving = s.step(now, dt);
          if (s.beats !== seen.beats) {
            seen.beats = s.beats;
            if (p.live) o.onBeat();
          }
          o.sparks.step(dt);
          const active = moving || o.sparks.alive > 0;
          const ctx = o.ctx.current;
          if (ctx && (active || seen.dirty)) {
            seen.dirty = active;
            ctx.clearRect(0, 0, o.size.w, o.size.h);
            o.draw(ctx, s);
            o.sparks.draw(ctx, '#fff', p.palette.vib);
          }
          o.styles(s);
          return p.live || active || seen.dirty;
        }
      : null,
  );
  // Back to live (a resume): the clock may have stopped after settling.
  useEffect(() => {
    if (p.live) clock.wake();
  }, [p.live]);
}

// ---------------------------------------------------------------- Card (W x 210)

// The box sits at (10, 10): W - 20 by 190. Box-relative design pixels below. The art is a
// 150 px square; the text column starts at box x 192 and takes the rest of the width, so a
// wider rect gives the title more room rather than a bigger, letterboxed card.
const CARD_H = 190;
const CARD_ART = { x: 20, y: 20, s: 150, corner: 14 };
const CARD_TEXT_X = 192;
const CARD_STRIP = { y: 113, h: 34 };
const CARD_EQ = { y: 24, h: 13 };

export function CardStyleCard(p: CardProps) {
  const root = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const artWrap = useRef<HTMLDivElement>(null);
  const artGlow = useRef<HTMLDivElement>(null);
  const pulse = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLDivElement>(null);
  const artist = useRef<HTMLDivElement>(null);
  const spec = useRef<HTMLDivElement>(null);
  const prog = useRef<HTMLDivElement>(null);
  const W = useFitWidth() - 20;
  const size = { w: W, h: CARD_H };
  const cv = useCanvas2d(W, CARD_H);
  const set = useMemo(setter, []);
  const sparks = useMemo(() => new Sparks({ x: 0, y: 0, w: W, h: CARD_H }), [W]);
  const painter = useMemo(() => new VizPainter(), []);
  const col = useMemo(() => vizColors(p.palette), [p.palette]);
  const strip: Box = { x: CARD_TEXT_X, y: CARD_STRIP.y, w: W - CARD_TEXT_X - 22, h: CARD_STRIP.h };
  const hasCanvas = !p.reduced && p.viz !== 'none';

  useCardTick(p, {
    root,
    ctx: cv.ctx,
    canvas: cv.el,
    size,
    sparks,
    draw: (ctx, s) => {
      painter.sync(`${W}|${col.vib}|${col.vibHi}|${col.domRgb}`);
      const a = CARD_ART;
      if (p.viz === 'ring') {
        const h = a.s / 2;
        painter.ring(ctx, a.x + h, a.y + h, h, a.corner, 3, 15, 3, s, col);
      } else {
        painter.strip(ctx, p.viz, strip, s, col);
      }
      drawEq(ctx, CARD_TEXT_X, CARD_EQ.y, CARD_EQ.h, s, p.palette.vibHi);
    },
    onBeat: () => {
      // Sparks leave the art's edge, mostly up and to the right, into the open card.
      const a = CARD_ART;
      for (let i = 0; i < 6; i++) {
        const side = Math.random();
        const x = side < 0.5 ? a.x + a.s : a.x + Math.random() * a.s;
        const y = side < 0.5 ? a.y + Math.random() * a.s : a.y;
        const ang = side < 0.5 ? (Math.random() - 0.5) * 1.2 : -Math.PI / 2 + (Math.random() - 0.5) * 1.4;
        sparks.spawn(x, y, ang, 60 + Math.random() * 90, 0.5 + Math.random() * 0.4);
      }
    },
    styles: (s) => {
      set(pulse.current, 'transform', `scale(${(1 + s.kick * 0.055 + s.low * 0.012).toFixed(3)})`);
      set(artGlow.current, 'opacity', (0.22 + s.kick * 0.6 + s.levelShown * 0.28).toFixed(2));
      set(artGlow.current, 'transform', `scale(${(1 + s.kick * 0.16).toFixed(3)})`);
      set(glow.current, 'opacity', (s.kick * 0.6 + s.levelShown * 0.12).toFixed(2));
    },
  });

  return (
    <CardFrame
      {...p}
      style="card"
      rootRef={root}
      glowRef={glow}
      parts={() => [
        {
          el: artWrap.current,
          frames: [
            { opacity: 0, transform: 'perspective(700px) rotateY(-80deg) scale(0.8)' },
            { opacity: 1, transform: 'none' },
          ],
          delay: 60,
          duration: 1100,
        },
        ...[top, title, artist, spec, prog].map((r, i) => ({ el: r.current, frames: slideIn, delay: 150 + i * 65 })),
      ]}
    >
      {hasCanvas && <canvas class="sp-canvas" ref={cv.ref} />}
      <div class="sp-art-wrap" ref={artWrap}>
        <div class="sp-art-glow" ref={artGlow} />
        <div class="sp-art-tilt">
          <div class="sp-art-pulse" ref={pulse}>
            <Art url={p.np.artUrl} sheen={p.sheen} sheenPath={p.backdrop === 'glass' ? cardSheenPath(W, CARD_ART.x) : null} />
          </div>
        </div>
      </div>
      <div class="sp-meta">
        <div class="sp-top" ref={top}>
          <span class="sp-label">
            {hasCanvas && <span class="sp-eq-slot" />}
            Now playing
          </span>
        </div>
        <div ref={title}>
          <Marquee class="sp-title" text={p.np.title} reduced={p.reduced} running={p.live} />
        </div>
        <div ref={artist}>
          <Marquee class="sp-artist" text={p.np.artists.join(', ')} reduced={p.reduced} running={p.live} />
        </div>
        <div class="sp-spec-slot" ref={spec} />
        <div ref={prog}>
          <Progress anchor={p.anchor} times active={!p.leaving} />
        </div>
      </div>
    </CardFrame>
  );
}

// ---------------------------------------------------------------- Pill (W x 112)

// Box at (8, 14): W - 16 by 88, fully round ends. The art is a 60 px disc centred at box
// (50, 44). Ring: spokes from radius 31 out to 43, inside the box's 44 px half-height. Strip
// styles play behind the text, dimmed, from box x 102 to the round end.
const PILL_H = 88;
const PILL_C = { x: 50, y: 44 };

export function CardStylePill(p: CardProps) {
  const root = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const artWrap = useRef<HTMLDivElement>(null);
  const artGlow = useRef<HTMLDivElement>(null);
  const pulse = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLDivElement>(null);
  const artist = useRef<HTMLDivElement>(null);
  const prog = useRef<HTMLDivElement>(null);
  const W = useFitWidth() - 16;
  const size = { w: W, h: PILL_H };
  const cv = useCanvas2d(W, PILL_H);
  const set = useMemo(setter, []);
  const sparks = useMemo(() => new Sparks({ x: 0, y: 0, w: W, h: PILL_H }), [W]);
  const painter = useMemo(() => new VizPainter(), []);
  const col = useMemo(() => vizColors(p.palette), [p.palette]);
  const strip: Box = { x: 102, y: 10, w: W - 102 - 34, h: PILL_H - 20 };

  useCardTick(p, {
    root,
    ctx: cv.ctx,
    canvas: cv.el,
    size,
    sparks,
    draw: (ctx, s) => {
      painter.sync(`${W}|${col.vib}|${col.vibHi}|${col.domRgb}`);
      if (p.viz === 'ring') painter.ring(ctx, PILL_C.x, PILL_C.y, 30, 30, 1, 13, 2.5, s, col);
      else painter.strip(ctx, p.viz, strip, s, col, 0.38);
    },
    onBeat: () => {
      // Out along the open side of the pill, towards the text.
      for (let i = 0; i < 5; i++) {
        const a = (Math.random() - 0.5) * 2.2;
        sparks.spawn(PILL_C.x + Math.cos(a) * 40, PILL_C.y + Math.sin(a) * 40, a, 70 + Math.random() * 80, 0.45 + Math.random() * 0.35);
      }
    },
    styles: (s) => {
      set(pulse.current, 'transform', `scale(${(1 + s.kick * 0.085 + s.low * 0.015).toFixed(3)})`);
      set(artGlow.current, 'opacity', (0.2 + s.kick * 0.65 + s.levelShown * 0.25).toFixed(2));
      set(glow.current, 'opacity', (s.kick * 0.55 + s.levelShown * 0.1).toFixed(2));
    },
  });

  return (
    <CardFrame
      {...p}
      style="pill"
      rootRef={root}
      glowRef={glow}
      parts={() => [
        {
          el: artWrap.current,
          frames: [{ opacity: 0, transform: 'rotate(-140deg) scale(0.5)' }, { opacity: 1, transform: 'none' }],
          delay: 60,
        },
        ...[title, artist, prog].map((r, i) => ({ el: r.current, frames: slideIn, delay: 140 + i * 70 })),
      ]}
    >
      {!p.reduced && p.viz !== 'none' && <canvas class="sp-canvas" ref={cv.ref} />}
      <div class="sp-art-wrap" ref={artWrap}>
        <div class="sp-art-glow" ref={artGlow} />
        <div class="sp-art-pulse" ref={pulse}>
          <div class="sp-spin">
            <Art url={p.np.artUrl} round />
          </div>
        </div>
      </div>
      <div class="sp-meta">
        <div ref={title}>
          <Marquee class="sp-title" text={p.np.title} reduced={p.reduced} running={p.live} />
        </div>
        <div ref={artist}>
          <Marquee class="sp-artist" text={p.np.artists.join(', ')} reduced={p.reduced} running={p.live} />
        </div>
      </div>
      <div class="sp-pill-progress" ref={prog}>
        <Progress anchor={p.anchor} active={!p.leaving} />
      </div>
    </CardFrame>
  );
}

// ---------------------------------------------------------------- Vinyl (380 x 480)

// The deck is a 300 x 300 square at design (40, 28), centred on the record at (190, 178). It
// tilts in 3D as one piece (record, ring, tonearm), so the ring's canvas sits inside the tilt:
// spokes from radius 117 around the 228 px record out to 140, inside the deck's 150. Strip
// styles draw in the gap between the record and the title instead (design 44, 298, 292 x 38).
const DECK = 300;
const DECK_C = DECK / 2;
const VINYL_STRIP = { w: 292, h: 38 };

export function CardStyleVinyl(p: CardProps) {
  const root = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const deck = useRef<HTMLDivElement>(null);
  const artGlow = useRef<HTMLDivElement>(null);
  const pulse = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLDivElement>(null);
  const artist = useRef<HTMLDivElement>(null);
  const prog = useRef<HTMLDivElement>(null);
  const ring = p.viz === 'ring';
  const size = ring ? { w: DECK, h: DECK } : VINYL_STRIP;
  const cv = useCanvas2d(size.w, size.h);
  const set = useMemo(setter, []);
  const sparks = useMemo(() => new Sparks({ x: 0, y: 0, ...size }), [size.w]);
  const painter = useMemo(() => new VizPainter(), []);
  const col = useMemo(() => vizColors(p.palette), [p.palette]);
  const hasCanvas = !p.reduced && p.viz !== 'none';

  useCardTick(p, {
    root,
    ctx: cv.ctx,
    canvas: cv.el,
    size,
    sparks,
    draw: (ctx, s) => {
      painter.sync(`${p.viz}|${col.vib}|${col.vibHi}|${col.domRgb}`);
      if (ring) painter.ring(ctx, DECK_C, DECK_C, 114, 114, 2, 26, 3.5, s, col);
      else painter.strip(ctx, p.viz, { x: 0, y: 0, ...VINYL_STRIP }, s, col);
    },
    onBeat: () => {
      if (!ring) return;
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2;
        sparks.spawn(DECK_C + Math.cos(a) * 118, DECK_C + Math.sin(a) * 118, a, 40 + Math.random() * 60, 0.5 + Math.random() * 0.4);
      }
    },
    styles: (s) => {
      set(pulse.current, 'transform', `scale(${(1 + s.kick * 0.028 + s.low * 0.006).toFixed(4)})`);
      set(artGlow.current, 'opacity', (0.16 + s.kick * 0.55 + s.levelShown * 0.22).toFixed(2));
      set(artGlow.current, 'transform', `scale(${(1 + s.kick * 0.1).toFixed(3)})`);
      set(glow.current, 'opacity', (s.kick * 0.5 + s.levelShown * 0.1).toFixed(2));
    },
  });

  return (
    <CardFrame
      {...p}
      style="vinyl"
      rootRef={root}
      glowRef={glow}
      parts={() => [
        {
          el: deck.current,
          frames: [
            { opacity: 0, transform: 'perspective(900px) translate3d(-60px, 0, 0) rotateY(35deg) rotate(-120deg)' },
            { opacity: 1, transform: 'none' },
          ],
          delay: 60,
          duration: 1200,
          easing: ease.springSoft,
        },
        ...[title, artist, prog].map((r, i) => ({ el: r.current, frames: slideIn, delay: 220 + i * 70 })),
      ]}
    >
      <div class="sp-deck" ref={deck}>
        <div class="sp-deck-tilt">
          <div class="sp-art-glow" ref={artGlow} />
          {hasCanvas && ring && <canvas class="sp-canvas" ref={cv.ref} />}
          <div class="sp-art-pulse sp-disc-pos" ref={pulse}>
            <div class="sp-disc sp-spin">
              <Art url={p.np.artUrl} round />
            </div>
          </div>
          <div class="sp-disc-sheen" />
          <Tonearm />
        </div>
      </div>
      {hasCanvas && !ring && <canvas class="sp-canvas sp-vinyl-strip" ref={cv.ref} />}
      <div class="sp-meta">
        <div ref={title}>
          <Marquee class="sp-title" text={p.np.title} reduced={p.reduced} running={p.live} />
        </div>
        <div ref={artist}>
          <Marquee class="sp-artist" text={p.np.artists.join(', ')} reduced={p.reduced} running={p.live} />
        </div>
        <div ref={prog}>
          <Progress anchor={p.anchor} times active={!p.leaving} />
        </div>
      </div>
    </CardFrame>
  );
}

function Tonearm() {
  return (
    <svg class="sp-tonearm" viewBox="0 0 140 240" aria-hidden="true">
      <defs>
        <linearGradient id="spArm" x1="0" x2="1">
          <stop offset="0" stop-color="#d9d9e3" />
          <stop offset="1" stop-color="#8d8d9c" />
        </linearGradient>
      </defs>
      <circle cx="110" cy="26" r="17" fill="#1d1d26" stroke="rgba(255,255,255,0.18)" stroke-width="2" />
      <circle cx="110" cy="26" r="7" fill="url(#spArm)" />
      <rect x="102" y="0" width="16" height="12" rx="3" fill="#2a2a35" />
      <path d="M110 26 L100 170 L46 210" fill="none" stroke="url(#spArm)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
      <g transform="rotate(38 40 216)">
        <rect x="26" y="206" width="28" height="18" rx="3" fill="#2a2a35" stroke="rgba(255,255,255,0.25)" stroke-width="1.5" />
        <rect x="36" y="222" width="8" height="5" rx="1" fill="var(--sp-vib-hi, #ddd)" />
      </g>
    </svg>
  );
}

export const CARD_COMPONENTS = { card: CardStyleCard, pill: CardStylePill, vinyl: CardStyleVinyl };
