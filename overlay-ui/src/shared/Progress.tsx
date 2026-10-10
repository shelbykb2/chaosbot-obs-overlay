import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';

/** Where playback was when a message arrived. `at` is performance.now() at receipt. */
export interface Anchor {
  ms: number;
  at: number;
  durationMs: number;
  playing: boolean;
}

/** Steps across a whole bar: two per design pixel of the widest bar (380 px). */
const STEPS_PER_BAR = 760;

export function anchorNow(a: Anchor, now = performance.now()): number {
  const run = a.playing ? now - a.at : 0;
  return Math.min(a.durationMs, Math.max(0, a.ms + run));
}

export function fmt(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/**
 * Progress bar with no per-frame JS. Each message re-anchors one linear compositor animation
 * from the reported position to the end of the track, timed to the time that is left. The
 * clock text ticks once a second, and only while playing and visible.
 */
export function Progress(props: { anchor: Anchor; times?: boolean; active: boolean; className?: string }) {
  const { anchor, active } = props;
  const fill = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const tEl = useRef<HTMLSpanElement>(null);
  const tRem = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const now = performance.now();
    const ms = anchorNow(anchor, now);
    const p = anchor.durationMs > 0 ? ms / anchor.durationMs : 0;
    const left = anchor.durationMs - ms;
    const run = anchor.playing && active && left > 0;
    const pairs: [HTMLElement | null, (q: number) => string][] = [
      [fill.current, (q) => `scaleX(${q})`],
      [head.current, (q) => `translateX(${q * 100}%)`],
    ];
    // A track moves the bar a pixel or two a second. Stepping it (about half a design pixel per
    // step) gives the compositor nothing new to draw between steps, where a smooth linear
    // animation would redraw the layer at the display rate for the whole song.
    const easing = `steps(${Math.max(1, Math.round((1 - p) * STEPS_PER_BAR))}, end)`;
    const anims: Animation[] = [];
    for (const [el, tf] of pairs) {
      if (!el) continue;
      el.style.transform = tf(p);
      if (run) anims.push(el.animate([{ transform: tf(p) }, { transform: tf(1) }], { duration: left, easing, fill: 'forwards' }));
    }
    // The next anchor sets the position again, so the old animation is simply dropped.
    return () => anims.forEach((a) => a.cancel());
  }, [anchor, active]);

  useEffect(() => {
    if (!props.times) return;
    let timer = 0;
    let lastSec = -1;
    const paint = () => {
      const ms = anchorNow(anchor);
      const sec = Math.floor(ms / 1000);
      if (sec !== lastSec) {
        lastSec = sec;
        if (tEl.current) tEl.current.textContent = fmt(ms);
        if (tRem.current) tRem.current.textContent = '-' + fmt(anchor.durationMs - ms);
      }
      if (anchor.playing && active) timer = window.setTimeout(paint, 1000 - (ms % 1000) + 5);
    };
    paint();
    return () => clearTimeout(timer);
  }, [anchor, active, props.times]);

  const bar = (
    <div class={'pr-bar' + (anchor.playing && active ? ' is-run' : '')}>
      <div class="pr-fill" ref={fill}>
        <i class="pr-shimmer" />
      </div>
      <div class="pr-track" ref={head}>
        <div class="pr-head" />
      </div>
    </div>
  );
  if (!props.times) return <div class={'pr ' + (props.className ?? '')}>{bar}</div>;
  return (
    <div class={'pr pr--times ' + (props.className ?? '')}>
      <span class="pr-t" ref={tEl}>0:00</span>
      {bar}
      <span class="pr-t pr-t-rem" ref={tRem}>-0:00</span>
    </div>
  );
}
