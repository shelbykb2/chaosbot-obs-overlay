import type { BackdropMode } from '../shared/Backdrop';
import { clampRect, type Design, type Rect } from '../shared/Region';
import { normaliseVisualizer, type VisualizerSetting } from '../shared/visualizers';

/** Hub message `nowPlaying` (SpotifyNowPlayingWire). null when nothing is playing. */
export interface NowPlaying {
  trackId: string;
  title: string;
  artists: string[];
  album: string;
  /** Same-origin (/api/spotify/art?id=...) so the art can be read on a canvas. */
  artUrl: string | null;
  /** Position when the host sent the message. */
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
}

export type CardStyle = 'card' | 'pill' | 'vinyl';

/** Hub message `spotifyConfig`, normalised. */
export interface CardConfig {
  enabled: boolean;
  rect: Rect;
  style: CardStyle;
  /** null = colours from the art. */
  accent: string | null;
  backdrop: BackdropMode;
  opacity: number;
  /** How the music is drawn, apart from the card style. */
  visualizer: VisualizerSetting;
  /** The light sweeping across the album cover. */
  coverSheen: boolean;
}

/**
 * Layout boxes in design pixels. The card and the pill fill the rect's height and stretch
 * their width to the rect (the text gets the room); the vinyl keeps its shape. The default
 * sizes match SpotifyCardShape.DesignSize in ChaosBot.Core.
 */
export const DESIGN: Record<CardStyle, Design> = {
  card: { w: 600, h: 210, minW: 470, maxW: 1100 },
  pill: { w: 520, h: 112, minW: 400, maxW: 1100 },
  vinyl: { w: 380, h: 480 },
};

export function normaliseConfig(raw: any): CardConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const style: CardStyle = raw.style === 'pill' || raw.style === 'vinyl' ? raw.style : 'card';
  const backdrop: BackdropMode = raw.backdrop === 'glass' || raw.backdrop === 'solid' ? raw.backdrop : 'art';
  const accent = typeof raw.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.accent) ? raw.accent : null;
  const op = Number(raw.opacity);
  return {
    enabled: raw.enabled !== false,
    rect: clampRect({ x: raw.x, y: raw.y, w: raw.w, h: raw.h }),
    style,
    accent,
    backdrop,
    opacity: Number.isFinite(op) ? Math.min(1, Math.max(0.3, op)) : 1,
    visualizer: normaliseVisualizer(raw.visualizer),
    coverSheen: raw.coverSheen !== false,
  };
}
