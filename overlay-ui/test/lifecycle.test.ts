// The card lifecycle rules (src/spotify/lifecycle.ts). Run with `npm test` (Node strips the types).
// The owner reported that after a pause, unpausing never brought the card back on OBS. These
// tests play the hub messages the host sends in that case and check the card returns every time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardLifecycle, type LifecycleState } from '../src/spotify/lifecycle.ts';

interface Np {
  trackId: string;
  isPlaying: boolean;
}

const GRACE = 2500;
const EXIT_MS = 420;

/** A fake clock with timers, and a stand-in for the page that plays the exit animation. */
function rig(opts: { load?: (np: Np) => Promise<string> } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let state: LifecycleState<Np, string> | null = null;
  let exitAt = -1;
  let exitKey = -1;
  const life = new CardLifecycle<Np, string>(
    {
      load: opts.load ?? (async () => 'palette'),
      fallback: () => 'fallback',
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimer: (id) => void timers.delete(id),
      render: (s) => {
        state = s;
        // The page starts the exit when shown turns false on a mounted card, and cancels it when
        // the card is asked back before it ends (CardFrame's effect cleanup).
        if (s.current && s.mounted && !s.shown && exitAt < 0) {
          exitAt = now + EXIT_MS;
          exitKey = s.current.key;
        } else if (s.shown) {
          exitAt = -1;
        }
      },
    },
    GRACE,
  );

  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      await flush();
      let first: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!first || e[1].at < first[1].at)) first = e;
      const nextExit = exitAt >= 0 && exitAt <= end ? exitAt : Infinity;
      if (!first && nextExit === Infinity) break;
      if (first && first[1].at <= nextExit) {
        now = first[1].at;
        timers.delete(first[0]);
        first[1].fn();
      } else {
        now = nextExit;
        exitAt = -1;
        life.exitDone(exitKey);
      }
    }
    now = end;
    await flush();
  }

  return {
    life,
    advance,
    /** The exit animation's end, fired right now (for ordering races). */
    finishExitNow() {
      if (exitAt >= 0) {
        exitAt = -1;
        life.exitDone(exitKey);
      }
    },
    get onScreen() {
      return !!(state && state.current && state.mounted && state.shown);
    },
    get state() {
      return state!;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const play = (id = 't1'): Np => ({ trackId: id, isPlaying: true });
const pause = (id = 't1'): Np => ({ trackId: id, isPlaying: false });

test('a playing track shows the card', async () => {
  const r = rig();
  r.life.nowPlaying(play());
  await r.advance(10);
  assert.equal(r.onScreen, true);
});

test('pause, wait past the grace period, resume: the card comes back', async () => {
  const r = rig();
  r.life.nowPlaying(play());
  await r.advance(1000);
  for (let i = 0; i < 5; i++) {
    r.life.nowPlaying(pause());
    await r.advance(GRACE + EXIT_MS + 3000);
    assert.equal(r.state.mounted, false, 'paused past the grace period: the card has left');
    r.life.nowPlaying(play());
    await r.advance(10);
    assert.equal(r.onScreen, true, `resume ${i + 1} brought the card back`);
  }
});

test('pause, then nothing playing (Spotify forgets after a long pause), then the same track: the card comes back', async () => {
  const r = rig();
  r.life.nowPlaying(play());
  await r.advance(1000);
  for (let i = 0; i < 3; i++) {
    r.life.nowPlaying(pause());
    await r.advance(GRACE + EXIT_MS + 500);
    r.life.nowPlaying(null);
    await r.advance(5000);
    assert.equal(r.onScreen, false);
    r.life.nowPlaying(play());
    await r.advance(10);
    assert.equal(r.onScreen, true, `resume ${i + 1} after an idle reading`);
  }
});

test('null while still shown, then the same track: the card comes back', async () => {
  const r = rig();
  r.life.nowPlaying(play());
  await r.advance(1000);
  r.life.nowPlaying(null);
  await r.advance(100); // mid-exit
  r.life.nowPlaying(play());
  await r.advance(EXIT_MS + 100);
  assert.equal(r.onScreen, true);
});

test('resume while the exit plays: the card stays', async () => {
  const r = rig();
  r.life.nowPlaying(play());
  await r.advance(500);
  r.life.nowPlaying(pause());
  await r.advance(GRACE + 200); // the exit is running
  r.life.nowPlaying(play());
  await r.advance(EXIT_MS + 1000);
  assert.equal(r.onScreen, true);
});

test('the exit ends just after the resume was handled, before the page re-rendered: the card stays', async () => {
  // The old page kept shown/mounted in Preact state and the exit callback unmounted the card
  // whatever had happened since. A resume handled in the same task as the animation's finish
  // event lost the card until the next change, and the host only publishes changes.
  const r = rig();
  r.life.nowPlaying(play());
  await r.advance(500);
  r.life.nowPlaying(pause());
  await r.advance(GRACE + 100);
  const key = r.state.current!.key;
  r.life.nowPlaying(play());
  r.life.exitDone(key); // the finish event, queued before the resume re-rendered
  await r.advance(10);
  assert.equal(r.onScreen, true);
});

test('art that fails to load still shows the card with the fallback colours', async () => {
  const r = rig({ load: () => Promise.reject(new Error('404')) });
  r.life.nowPlaying(play());
  await r.advance(10);
  assert.equal(r.onScreen, true);
  assert.equal(r.state.current!.palette, 'fallback');
});

test('a load that throws synchronously still shows the card', async () => {
  const r = rig({
    load: () => {
      throw new Error('boom');
    },
  });
  r.life.nowPlaying(play());
  await r.advance(10);
  assert.equal(r.onScreen, true);
});

test('a new track replaces the old one, which leaves', async () => {
  const r = rig();
  r.life.nowPlaying(play('a'));
  await r.advance(10);
  r.life.nowPlaying(play('b'));
  await r.advance(10);
  assert.equal(r.state.current!.np.trackId, 'b');
  assert.equal(r.state.leaving.length, 1);
  r.life.leftDone(r.state.leaving[0]);
  assert.equal(r.state.leaving.length, 0);
  assert.equal(r.onScreen, true);
});

test('a short pause inside the grace period never hides the card', async () => {
  const r = rig();
  r.life.nowPlaying(play());
  await r.advance(10);
  r.life.nowPlaying(pause());
  await r.advance(GRACE - 500);
  r.life.nowPlaying(play());
  await r.advance(GRACE * 2);
  assert.equal(r.onScreen, true);
  assert.equal(r.state.shown, true);
});

test('a track that starts paused shows, then leaves after the grace period', async () => {
  const r = rig();
  r.life.nowPlaying(pause());
  await r.advance(10);
  assert.equal(r.onScreen, true);
  await r.advance(GRACE + EXIT_MS + 10);
  assert.equal(r.state.mounted, false);
  r.life.nowPlaying(play());
  await r.advance(10);
  assert.equal(r.onScreen, true);
});
