import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { clock } from '../shared/clock';
import { param, useReducedMotion, useVisible } from '../shared/env';
import { useHub } from '../shared/hub';
import { extractPalette, fallbackPalette, withAccent, type Palette } from '../shared/palette';
import type { Anchor } from '../shared/Progress';
import { Region } from '../shared/Region';
import { Spectrum } from '../shared/spectrum';
import { resolveVisualizer } from '../shared/visualizers';
import { CARD_COMPONENTS } from './cards';
import { CardLifecycle, type LifecycleState } from './lifecycle';
import { DESIGN, normaliseConfig, type CardConfig, type NowPlaying } from './types';

const PAUSE_GRACE_MS = 2500;
/** Art that has not decoded by then is drawn with the fallback colours, so a slow or stuck
 *  image never keeps the card off screen. */
const ART_TIMEOUT_MS = 2500;

const demoParam = param('demo') === '1';

/** The fake player demo.ts puts on window once it has started. */
function demoPlayer(): { setPlaying(on: boolean): void } | undefined {
  return (window as unknown as { spotifyDemo?: { setPlaying(on: boolean): void } }).spotifyDemo;
}

async function loadTrack(np: NowPlaying): Promise<Palette> {
  if (!np.artUrl) return fallbackPalette();
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = np.artUrl;
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('art timed out')), ART_TIMEOUT_MS);
  });
  try {
    await Promise.race([img.decode(), timeout]);
    return extractPalette(img);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The now-playing card page (/spotify/). Live: hub messages nowPlaying, spotifyConfig and
 * spectrum. Demo (?demo=1): a fake player, no hub, with style/accent/backdrop/opacity/visualizer
 * from the query string.
 *
 * When the card shows, waits and leaves is decided by CardLifecycle (lifecycle.ts, tested on its
 * own): a pause keeps the card for 2.5 s, then it leaves; a resume brings it back, even after
 * Spotify reported nothing in between.
 *
 * The overlay editor renders the same component with `config` (the card element's settings,
 * which then win over any spotifyConfig message), `demo` (sample tracks, no hub) and `playing`
 * (pauses and resumes the sample track).
 */
export function SpotifyOverlay(props: { config?: CardConfig | null; demo?: boolean; playing?: boolean } = {}) {
  const demo = props.demo ?? demoParam;
  const reduced = useReducedMotion();
  const visible = useVisible();
  const [hubCfg, setCfg] = useState<CardConfig | null>(null);
  const cfg = props.config !== undefined ? props.config : hubCfg;
  const [anchor, setAnchor] = useState<Anchor>({ ms: 0, at: 0, durationMs: 1, playing: false });
  const [life, setLife] = useState<LifecycleState<NowPlaying, Palette>>({ current: null, shown: false, mounted: false, leaving: [] });
  const spectrum = useMemo(() => new Spectrum(), []);
  /** Spectrum frames are decoded only while something draws them. */
  const takeFrames = useRef(false);

  const lifecycle = useMemo(
    () =>
      new CardLifecycle<NowPlaying, Palette>(
        {
          load: loadTrack,
          fallback: fallbackPalette,
          setTimer: (fn, ms) => window.setTimeout(fn, ms),
          clearTimer: (id) => clearTimeout(id),
          render: setLife,
        },
        PAUSE_GRACE_MS,
      ),
    [],
  );
  useEffect(() => () => lifecycle.dispose(), []);

  const handlers = useMemo(
    () => ({
      nowPlaying(np: NowPlaying | null) {
        if (np && np.trackId) {
          const playing = !!np.isPlaying;
          setAnchor({ ms: Math.max(0, +np.progressMs || 0), at: performance.now(), durationMs: Math.max(1, +np.durationMs || 1), playing });
        } else {
          setAnchor((a) => ({ ...a, playing: false }));
        }
        lifecycle.nowPlaying(np && np.trackId ? np : null);
      },
      spotifyConfig: (raw: unknown) => {
        const c = normaliseConfig(raw);
        if (c) setCfg(c);
      },
      spectrum: (frame: unknown) => {
        // Nothing to draw: do not even decode the frame.
        if (!takeFrames.current) return;
        if (spectrum.push(frame)) clock.wake();
      },
    }),
    [],
  );

  useHub(handlers, !demo);
  useEffect(() => {
    if (!demo) return;
    let stop = () => {};
    import('./demo').then((m) => {
      stop = m.startDemo(handlers);
      if (props.playing === false) demoPlayer()?.setPlaying(false);
    });
    return () => stop();
  }, []);
  // The editor's Preview button. A paused sample leaves after the grace period, as in OBS.
  useEffect(() => {
    if (demo && props.playing !== undefined) demoPlayer()?.setPlaying(props.playing);
  }, [props.playing]);

  const enabled = !!cfg?.enabled;
  const { current, shown, mounted, leaving } = life;
  const viz = resolveVisualizer(cfg?.visualizer ?? 'auto', cfg?.style ?? 'card');
  /** The clock may tick: the card is on the page and can be seen. */
  const run = enabled && mounted && visible && !reduced;
  /** Music is playing into it. */
  const live = run && shown && anchor.playing;
  useEffect(() => {
    takeFrames.current = live && viz !== 'none';
    clock.setAllowed(run);
    if (live) clock.wake();
    if (!run) spectrum.reset();
  }, [live, run, viz]);

  const palette = useMemo(() => (current ? withAccent(current.palette, cfg?.accent ?? null) : null), [current, cfg?.accent]);

  if (!cfg || !enabled) return null;
  const Card = CARD_COMPONENTS[cfg.style];
  const common = { anchor, backdrop: cfg.backdrop, sheen: cfg.coverSheen, spectrum, reduced, viz };

  return (
    <Region rect={cfg.rect} design={DESIGN[cfg.style]} opacity={cfg.opacity} className={reduced ? 'ov-reduced' : ''}>
      {leaving.map((l) => (
        <Card
          key={'l' + l.key + cfg.style}
          {...common}
          np={l.np}
          palette={withAccent(l.palette, cfg.accent)}
          live={false}
          run={false}
          leaving
          onGone={() => lifecycle.leftDone(l)}
        />
      ))}
      {current && mounted && palette && (
        <Card
          key={'c' + current.key + cfg.style}
          {...common}
          np={current.np}
          palette={palette}
          live={live}
          run={run}
          leaving={!shown}
          onGone={() => lifecycle.exitDone(current.key)}
        />
      )}
    </Region>
  );
}
