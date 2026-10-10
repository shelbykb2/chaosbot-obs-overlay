/**
 * Entrance and exit choreography on the Web Animations API. Every animation here runs on
 * transform and opacity, so the compositor plays it without the page's main thread.
 */

/** A spring as a CSS linear() easing, sampled once. Falls back to an overshooting bezier on
 *  Chromium before 113 (OBS 30's CEF), which does not know linear(). */
function spring(stiffness: number, damping: number, samples = 40): string {
  const fallback = 'cubic-bezier(0.34, 1.4, 0.64, 1)';
  if (typeof CSS === 'undefined' || !CSS.supports('animation-timing-function', 'linear(0, 1)')) return fallback;
  // Unit mass, starting at 0 heading for 1, simulated to rest (about 1 s for these values).
  const pts: string[] = [];
  let x = 0, v = 0;
  const T = 1;
  const steps = samples * 8;
  const dt = T / steps;
  for (let i = 0; i <= steps; i++) {
    if (i % 8 === 0) pts.push((Math.round(x * 1000) / 1000).toString());
    const a = stiffness * (1 - x) - damping * v;
    v += a * dt;
    x += v * dt;
  }
  pts[pts.length - 1] = '1';
  return `linear(${pts.join(', ')})`;
}

export const ease = {
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  /** Lively, a little overshoot. Duration ~1000 ms. */
  spring: spring(170, 14),
  /** Settles with barely any overshoot. Duration ~1000 ms. */
  springSoft: spring(120, 17),
};

export type Frames = Keyframe[];

export interface EnterPart {
  el: Element | null;
  frames: Frames;
  delay?: number;
  duration?: number;
  easing?: string;
}

/** Plays a staggered entrance. Reduced motion: one short fade on the root, nothing else. */
export function playEnter(root: Element | null, parts: EnterPart[], reduced: boolean) {
  if (!root) return;
  if (reduced) {
    root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
    return;
  }
  root.animate(
    [{ opacity: 0, transform: 'translate3d(-24px, 0, 0) scale(0.97)' }, { opacity: 1, transform: 'none' }],
    { duration: 900, easing: ease.springSoft },
  );
  for (const p of parts) {
    p.el?.animate(p.frames, {
      duration: p.duration ?? 1000,
      delay: p.delay ?? 0,
      easing: p.easing ?? ease.spring,
      fill: 'backwards',
    });
  }
}

/** Plays the exit and calls `done` when it ends. Cancelling the returned animation (the card
 *  was asked back before it finished leaving) puts it back and does not call `done`. */
export function playExit(root: Element | null, reduced: boolean, done: () => void): Animation | null {
  if (!root) {
    done();
    return null;
  }
  const a = root.animate(
    reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translate3d(0, 14px, 0) scale(0.96)' }],
    { duration: reduced ? 300 : 420, easing: ease.in, fill: 'forwards' },
  );
  a.onfinish = done;
  return a;
}

/** Standard stagger frames: slide in from the right. */
export const slideIn: Frames = [
  { opacity: 0, transform: 'translate3d(22px, 0, 0)' },
  { opacity: 1, transform: 'none' },
];
