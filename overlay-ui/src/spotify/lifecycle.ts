/**
 * When the now-playing card is on the page, apart from Preact, so the rules can be tested on
 * their own (overlay-ui/test/lifecycle.test.ts).
 *
 * - A new track loads its art (and palette) first, then swaps in. The old card leaves.
 * - Pausing keeps the card for `graceMs`, then it leaves and is removed from the page, so a
 *   paused or idle page has nothing left that animates or ticks.
 * - A resume brings it back: the same track after a pause, or the same track again after an
 *   idle reading (Spotify reports nothing after a long pause, then the track on resume).
 *
 * `shown` and `mounted` live here as plain fields, not in Preact state, so a handler always reads
 * what the last message decided. The exit animation's end is checked against them: an exit that
 * finishes after the card was asked back does not remove it.
 */
export interface TrackLike {
  trackId: string;
  isPlaying: boolean;
}

export interface Loaded<T, P> {
  np: T;
  palette: P;
  key: number;
}

export interface LifecycleState<T, P> {
  current: Loaded<T, P> | null;
  /** The card is wanted on screen. False starts its exit. */
  shown: boolean;
  /** The card is in the page. False once its exit has finished. */
  mounted: boolean;
  /** Cards replaced by a newer track, playing their exit. */
  leaving: Loaded<T, P>[];
}

export interface LifecycleHost<T, P> {
  /** Loads the art and palette for a track. May reject; the fallback is used then. */
  load(np: T): Promise<P>;
  fallback(): P;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
  /** Called with a new state object after every change. */
  render(state: LifecycleState<T, P>): void;
}

export class CardLifecycle<T extends TrackLike, P> {
  private token = 0;
  private trackId: string | null = null;
  private loadedId: string | null = null;
  private playing = false;
  private pauseTimer = 0;
  private st: LifecycleState<T, P> = { current: null, shown: false, mounted: false, leaving: [] };
  private readonly host: LifecycleHost<T, P>;
  private readonly graceMs: number;

  constructor(host: LifecycleHost<T, P>, graceMs: number) {
    this.host = host;
    this.graceMs = graceMs;
  }

  get state(): LifecycleState<T, P> {
    return this.st;
  }

  get isPlaying() {
    return this.playing;
  }

  nowPlaying(np: T | null) {
    if (!np || !np.trackId) {
      this.playing = false;
      this.trackId = null;
      this.token++;
      this.clearPause();
      this.set({ shown: false });
      return;
    }
    this.playing = !!np.isPlaying;

    if (np.trackId !== this.trackId) {
      this.trackId = np.trackId;
      const token = ++this.token;
      let p: Promise<P>;
      try {
        p = this.host.load(np);
      } catch {
        p = Promise.reject();
      }
      p.catch(() => this.host.fallback()).then((palette) => this.loaded(np, palette, token));
      return;
    }

    // The same track: a pause, a resume, or a progress correction.
    if (this.playing) {
      this.clearPause();
      if (this.loadedId === np.trackId && this.st.current) {
        // A newer reading of the loaded track (a resume brings a fresh progress).
        this.set({ current: { ...this.st.current, np }, shown: true, mounted: true });
      }
    } else {
      if (this.loadedId === np.trackId && this.st.current) this.set({ current: { ...this.st.current, np } });
      this.schedulePauseHide();
    }
  }

  /** The current card's exit animation finished. */
  exitDone(key: number) {
    const cur = this.st.current;
    // Asked back while it was leaving, or already replaced: keep what the last message decided.
    if (this.st.shown || !cur || cur.key !== key || !this.st.mounted) return;
    this.set({ mounted: false });
  }

  /** A replaced card's exit finished. */
  leftDone(item: Loaded<T, P>) {
    if (!this.st.leaving.includes(item)) return;
    this.set({ leaving: this.st.leaving.filter((x) => x !== item) });
  }

  dispose() {
    this.clearPause();
    this.token++;
  }

  private loaded(np: T, palette: P, token: number) {
    if (token !== this.token) return; // a newer reading arrived while the art loaded
    this.loadedId = np.trackId;
    const old = this.st.current;
    const leaving = old && this.st.mounted ? [...this.st.leaving, old] : this.st.leaving;
    // The newest reading of this track wins (it may have paused or resumed during the load).
    this.set({ current: { np, palette, key: token }, leaving, mounted: true, shown: true });
    if (!this.playing) this.schedulePauseHide();
  }

  private schedulePauseHide() {
    if (this.pauseTimer) return;
    this.pauseTimer = this.host.setTimer(() => {
      this.pauseTimer = 0;
      if (!this.playing) this.set({ shown: false });
    }, this.graceMs);
  }

  private clearPause() {
    if (this.pauseTimer) this.host.clearTimer(this.pauseTimer);
    this.pauseTimer = 0;
  }

  private set(patch: Partial<LifecycleState<T, P>>) {
    this.st = { ...this.st, ...patch };
    this.host.render(this.st);
  }
}
