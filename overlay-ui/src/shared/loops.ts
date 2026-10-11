/**
 * Plays a piece's decorative CSS loops (drift, aurora, spin, tilt, sweep, shimmer, marquee) on
 * the shared 30 fps clock.
 *
 * The keyframes stay in CSS and every loop is declared `paused`. Each clock frame sets their
 * currentTime. Measured in headless Edge, freely running compositor loops made the page draw at
 * the display rate (60 Hz) and cost about 8% of a core in the GPU process; on the clock the
 * whole piece draws 30 times a second, and when the clock stops the loops simply hold.
 *
 * WAAPI animations (entrances, exits, the progress bar) are not CSSAnimations and are left
 * alone.
 */
export class LoopDriver {
  private list: Animation[] = [];
  private start = new WeakMap<Animation, number>();
  private t = 0;
  private scannedAt = -1e9;

  constructor(private root: () => Element | null) {}

  tick(now: number, dt: number) {
    const r = this.root();
    if (!r) return;
    this.t += dt * 1000;
    // New loops appear rarely (a marquee that starts scrolling), so look twice a second.
    if (now - this.scannedAt > 500) {
      this.scannedAt = now;
      this.list = r.getAnimations({ subtree: true }).filter(isCssAnimation);
    }
    for (const a of this.list) {
      if (a.playState === 'idle') continue;
      let s = this.start.get(a);
      if (s === undefined) this.start.set(a, (s = this.t)); // a loop starts at its beginning
      a.currentTime = this.t - s;
    }
  }
}

const isCssAnimation = (a: Animation) => typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation;
