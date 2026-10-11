import { useMemo } from 'preact/hooks';
import type { BackdropMode } from '../shared/Backdrop';
import { normaliseVisualizer } from '../shared/visualizers';
import { SpotifyOverlay } from '../spotify/SpotifyOverlay';
import type { CardConfig, CardStyle } from '../spotify/types';
import { CANVAS } from './model';
import { register, type StageProps } from './registry';

/* Element types in this build: the Spotify card and the no-go zone. Their props are the ones
   ChaosBot maps to the older stores (OverlaySceneMapping): the card's to the Spotify widget,
   the zone's `laugh` to the layout zone. */

const ACCENTS = [
  { value: '#9455FF', name: 'Purple' },
  { value: '#FF4F9A', name: 'Pink' },
  { value: '#2EE6C5', name: 'Teal' },
  { value: '#C8FF6A', name: 'Lime' },
  { value: '#FFB547', name: 'Orange' },
  { value: '#4AA3FF', name: 'Blue' },
];

/** The card exactly as /spotify/ draws it, from the element instead of the hub's spotifyConfig.
    Sample tracks in the editor, the real player in OBS. */
function SpotifyStage({ el, playing, live }: StageProps) {
  const p = el.props;
  const config = useMemo<CardConfig>(
    () => ({
      enabled: true,
      rect: { x: el.rect.x / CANVAS.w, y: el.rect.y / CANVAS.h, w: el.rect.w / CANVAS.w, h: el.rect.h / CANVAS.h },
      style: (p.style === 'pill' || p.style === 'vinyl' ? p.style : 'card') as CardStyle,
      accent: typeof p.accent === 'string' && /^#[0-9a-f]{6}$/i.test(p.accent) ? p.accent : null,
      backdrop: (p.backdrop === 'glass' || p.backdrop === 'solid' ? p.backdrop : 'art') as BackdropMode,
      opacity: Math.min(1, Math.max(0.3, Number(p.opacity) || 1)),
      visualizer: normaliseVisualizer(p.visualizer),
      coverSheen: p.coverSheen !== false,
    }),
    [el.rect.x, el.rect.y, el.rect.w, el.rect.h, p.style, p.accent, p.backdrop, p.opacity, p.visualizer, p.coverSheen],
  );
  return live ? <SpotifyOverlay config={config} demo={false} /> : <SpotifyOverlay config={config} demo playing={playing} />;
}

register({
  type: 'spotify',
  label: 'Spotify card',
  blurb: "What's playing, with a live spectrum",
  icon: '',
  tone: 'menu-ic-sp',
  single: true,
  size: { w: 600, h: 210 },
  min: { w: 96, h: 54 },
  avoidByDefault: true,
  feeds: ['spotify'],
  defaults: { style: 'card', accent: 'auto', backdrop: 'art', opacity: 1, visualizer: 'auto', coverSheen: true },
  fields: [
    {
      kind: 'pick',
      key: 'style',
      label: 'Style',
      options: [
        { value: 'card', label: 'Card' },
        { value: 'pill', label: 'Pill' },
        { value: 'vinyl', label: 'Vinyl' },
      ],
    },
    {
      kind: 'pick',
      key: 'backdrop',
      label: 'Backdrop',
      options: [
        { value: 'art', label: 'Album art' },
        { value: 'glass', label: 'Glass' },
        { value: 'solid', label: 'Solid' },
      ],
    },
    { kind: 'swatches', key: 'accent', label: 'Accent', auto: 'auto', hint: 'Auto takes the colours from the album art.', options: ACCENTS },
    {
      kind: 'pick',
      key: 'visualizer',
      label: 'Visualizer',
      hint: 'How the card moves with the music. None stops the audio capture too.',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'bars', label: 'Bars' },
        { value: 'mirror', label: 'Mirror' },
        { value: 'dots', label: 'Dots' },
        { value: 'wave', label: 'Wave' },
        { value: 'ring', label: 'Ring' },
        { value: 'none', label: 'None' },
      ],
    },
    { kind: 'toggle', key: 'coverSheen', label: 'Shine on the cover', hint: 'A slow light across the album art.' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.3, max: 1, step: 0.05, percent: true },
  ],
  Stage: SpotifyStage,
});

register({
  type: 'nogo',
  label: 'No-go zone',
  blurb: 'Chaos never pops in here. OBS never shows it.',
  icon: '',
  tone: 'menu-ic-zone',
  size: { w: 416, h: 241 },
  // The smallest zone ChaosBot keeps (OverlaySceneMapping.MinNoGoW and MinNoGoH).
  min: { w: 77, h: 44 },
  avoidByDefault: true,
  editorOnly: true,
  named: true,
  defaults: { laugh: false },
  fields: [{ kind: 'toggle', key: 'laugh', label: 'Laugh toward', hint: 'Chaos looks and laughs at this spot when he pops in. Good for a facecam.' }],
});
import './basics';
import './feed';
import './chat';
import './alerts';
import './extras';
