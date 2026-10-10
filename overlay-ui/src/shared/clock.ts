import { useEffect, useRef } from 'preact/hooks';

/**
 * The one animation clock for every JS-driven motion on a page.
 *
 * - At most 30 frames a second: a timeout waits out the gap, then one requestAnimationFrame
 *   lands the frame on a vsync. A 60 Hz display therefore wakes the page 30 times, not 60.
 * - It runs only while the page allows it (`setAllowed`: playing, visible, enabled, motion on)
 *   and while some subscriber still has motion to finish. Each subscriber returns true while it
 *   wants more frames; when none does, the clock stops until `wake()`.
 * - When it is stopped there is no timer, interval or rAF pending at all.
 */
export type TickFn = (now: number, dt: number) => boolean;

const FRAME_MS = 1000 / 30;
const subs = new Set<TickFn>();
let allowed = false;
let raf = 0;
let timer = 0;
let last = 0;

function stop() {
  if (raf) cancelAnimationFrame(raf);
  if (timer) clearTimeout(timer);
  raf = 0;
  timer = 0;
}

function frame(now: number) {
  raf = 0;
  if (!allowed) return;
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  let more = false;
  for (const fn of subs) if (fn(now, dt)) more = true;
  if (more) schedule(now);
}

function schedule(from: number) {
  const wait = FRAME_MS - (performance.now() - from) - 6; // leave room for the vsync wait
  if (wait > 1) {
    timer = window.setTimeout(() => {
      timer = 0;
      raf = requestAnimationFrame(frame);
    }, wait);
  } else {
    raf = requestAnimationFrame(frame);
  }
}

export const clock = {
  setAllowed(on: boolean) {
    if (on === allowed) return;
    allowed = on;
    if (on) clock.wake();
    else stop();
  },
  /** Something new to animate (a spectrum frame arrived): start the loop if it is idle. */
  wake() {
    if (!allowed || raf || timer || subs.size === 0) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  },
  get running() {
    return raf !== 0 || timer !== 0;
  },
};

/** Subscribes a tick for the component's lifetime. The latest callback is always used. */
export function useClock(fn: TickFn | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!ref.current) return;
    const tick: TickFn = (now, dt) => (ref.current ? ref.current(now, dt) : false);
    subs.add(tick);
    clock.wake();
    return () => {
      subs.delete(tick);
    };
  }, [fn === null]);
}
