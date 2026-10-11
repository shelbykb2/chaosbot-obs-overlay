import { Region } from '../shared/Region';
import '../shared/elements.css';
import { imageUrl } from '../shared/images';
import { CANVAS, type El, type PropValue } from './model';
import { register, type StageProps } from './registry';

/* Text, Image and Shape. Each draws inside its rect at canvas pixels (Region scales the 1920 x
   1080 design to the page), so a 64 px heading is 64 px on a 1080p stream. Styles are in
   shared/elements.css and stay inside OBS's Chromium 103. */

export const COLORS = [
  { value: '#FFFFFF', name: 'White' },
  { value: '#121116', name: 'Ink' },
  { value: '#9455FF', name: 'Purple' },
  { value: '#FF4F9A', name: 'Pink' },
  { value: '#2EE6C5', name: 'Teal' },
  { value: '#C8FF6A', name: 'Lime' },
  { value: '#FFB547', name: 'Orange' },
  { value: '#4AA3FF', name: 'Blue' },
  { value: '#FF4D6D', name: 'Red' },
];

const HEX = /^#[0-9a-f]{6}$/i;
const color = (v: PropValue | undefined, d: string) => (typeof v === 'string' && HEX.test(v) ? v : d);
const num = (v: PropValue | undefined, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const pick = <T extends string>(v: PropValue | undefined, options: readonly T[], d: T): T =>
  options.includes(v as T) ? (v as T) : d;

const fraction = (el: El) => ({ x: el.rect.x / CANVAS.w, y: el.rect.y / CANVAS.h, w: el.rect.w / CANVAS.w, h: el.rect.h / CANVAS.h });
const design = (el: El) => ({ w: el.rect.w, h: el.rect.h });

/* ---------------------------------------------------------------- text */

const FONTS = {
  clean: '"Segoe UI Variable Display", "Segoe UI", sans-serif',
  condensed: 'Bahnschrift, "Segoe UI", sans-serif',
  heavy: 'Impact, "Arial Black", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Cascadia Mono", Consolas, monospace',
  hand: '"Segoe Print", "Comic Sans MS", cursive',
} as const;
type Font = keyof typeof FONTS;
const FONT_KEYS = Object.keys(FONTS) as Font[];

/** The text-shadow for an effect. An outline is eight offset shadows: text-stroke thins letters. */
export function textEffect(effect: string, size: number, c: string): string | undefined {
  if (effect === 'shadow') return `0 ${Math.round(size * 0.05)}px ${Math.round(size * 0.25)}px rgba(0, 0, 0, 0.7)`;
  if (effect === 'glow') return `0 0 ${Math.round(size * 0.2)}px ${c}, 0 0 ${Math.round(size * 0.5)}px ${c}`;
  if (effect === 'outline') {
    const w = Math.max(2, Math.round(size * 0.05));
    const d = Math.round(w * 0.7);
    return [`${w}px 0`, `-${w}px 0`, `0 ${w}px`, `0 -${w}px`, `${d}px ${d}px`, `-${d}px ${d}px`, `${d}px -${d}px`, `-${d}px -${d}px`]
      .map((o) => `${o} 0 #000`)
      .join(', ');
  }
  return undefined;
}

function TextStage({ el, live }: StageProps) {
  const p = el.props;
  const size = num(p.size, 12, 320, 64);
  const c = color(p.color, '#FFFFFF');
  const align = pick(p.align, ['left', 'center', 'right'] as const, 'left');
  const plate = pick(p.plate, ['none', 'dark', 'light'] as const, 'none');
  const text = typeof p.text === 'string' ? p.text : '';
  return (
    <Region rect={fraction(el)} design={design(el)} opacity={num(p.opacity, 0.1, 1, 1)}>
      <div
        class={'el-text pl-' + plate + (p.caps === true ? ' is-caps' : '')}
        style={{
          fontFamily: FONTS[pick(p.font, FONT_KEYS, 'clean')],
          fontSize: size + 'px',
          fontWeight: p.weight === 'black' ? 900 : p.weight === 'regular' ? 400 : 700,
          color: c,
          textAlign: align,
          justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
          textShadow: textEffect(String(p.effect), size, c),
        }}
      >
        <span>{text || (live ? '' : 'Type your text')}</span>
      </div>
    </Region>
  );
}

register({
  type: 'text',
  label: 'Text',
  blurb: 'A heading, your socials, a schedule',
  icon: '',
  tone: 'menu-ic-text',
  size: { w: 640, h: 120 },
  min: { w: 24, h: 16 },
  avoidByDefault: true,
  named: true,
  defaults: { text: 'Your text here', font: 'clean', size: 64, weight: 'bold', color: '#FFFFFF', align: 'left', effect: 'shadow', plate: 'none', caps: false, opacity: 1 },
  fields: [
    { kind: 'text', key: 'text', label: 'Text', max: 500, placeholder: 'Type your text' },
    {
      kind: 'pick',
      key: 'font',
      label: 'Font',
      options: [
        { value: 'clean', label: 'Clean' },
        { value: 'condensed', label: 'Condensed' },
        { value: 'heavy', label: 'Heavy' },
        { value: 'serif', label: 'Serif' },
        { value: 'mono', label: 'Mono' },
        { value: 'hand', label: 'Hand' },
      ],
    },
    { kind: 'slider', key: 'size', label: 'Size', min: 12, max: 320, step: 1, unit: 'px' },
    {
      kind: 'pick',
      key: 'weight',
      label: 'Weight',
      options: [
        { value: 'regular', label: 'Regular' },
        { value: 'bold', label: 'Bold' },
        { value: 'black', label: 'Black' },
      ],
    },
    { kind: 'swatches', key: 'color', label: 'Colour', options: COLORS },
    {
      kind: 'pick',
      key: 'align',
      label: 'Align',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Centre' },
        { value: 'right', label: 'Right' },
      ],
    },
    {
      kind: 'pick',
      key: 'effect',
      label: 'Effect',
      hint: 'A shadow or outline keeps text readable over a busy game.',
      options: [
        { value: 'none', label: 'None' },
        { value: 'shadow', label: 'Shadow' },
        { value: 'outline', label: 'Outline' },
        { value: 'glow', label: 'Glow' },
      ],
    },
    {
      kind: 'pick',
      key: 'plate',
      label: 'Behind the text',
      options: [
        { value: 'none', label: 'Nothing' },
        { value: 'dark', label: 'Dark panel' },
        { value: 'light', label: 'Light panel' },
      ],
    },
    { kind: 'toggle', key: 'caps', label: 'All capitals' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.1, max: 1, step: 0.05, percent: true },
  ],
  Stage: TextStage,
});

/* ---------------------------------------------------------------- image */

function ImageStage({ el, live }: StageProps) {
  const p = el.props;
  const src = imageUrl(p.file, !!live);
  const fit = pick(p.fit, ['contain', 'cover', 'fill'] as const, 'contain');
  if (!src && live) return null;
  return (
    <Region rect={fraction(el)} design={design(el)} opacity={num(p.opacity, 0.1, 1, 1)}>
      {src ? (
        <img class="el-img" src={src} alt="" draggable={false} style={{ objectFit: fit, borderRadius: num(p.radius, 0, 540, 0) + 'px' }} />
      ) : (
        <div class="el-img-empty">
          <span>Choose a picture in the panel on the right, or drop one here</span>
        </div>
      )}
    </Region>
  );
}

register({
  type: 'image',
  label: 'Image',
  blurb: 'A logo, a frame, a sticker. PNG, JPG, GIF or WebP',
  icon: '',
  tone: 'menu-ic-img',
  size: { w: 480, h: 270 },
  min: { w: 16, h: 16 },
  avoidByDefault: true,
  named: true,
  defaults: { file: '', fit: 'contain', radius: 0, opacity: 1 },
  fields: [
    { kind: 'image', key: 'file', label: 'Picture', hint: 'PNG, JPG, GIF or WebP, up to 8 MB. Animated GIFs move in OBS too.' },
    {
      kind: 'pick',
      key: 'fit',
      label: 'Fit',
      hint: 'Fit shows all of it. Fill crops to the box. Stretch fills the box exactly.',
      options: [
        { value: 'contain', label: 'Fit' },
        { value: 'cover', label: 'Fill' },
        { value: 'fill', label: 'Stretch' },
      ],
    },
    { kind: 'slider', key: 'radius', label: 'Rounded corners', min: 0, max: 160, step: 1, unit: 'px' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.1, max: 1, step: 0.05, percent: true },
  ],
  Stage: ImageStage,
});

/* ---------------------------------------------------------------- shape */

const SHAPES = ['box', 'pill', 'circle', 'line'] as const;
const FILLS = ['solid', 'outline', 'fade'] as const;

/** The CSS for a shape. Kept apart from the component so it can be tested. */
export function shapeStyle(props: Record<string, PropValue>, h: number): Record<string, string> {
  const shape = pick(props.shape, SHAPES, 'box');
  const c = color(props.color, '#9455FF');
  const t = num(props.thickness, 1, 48, 4);
  if (shape === 'line') return { height: t + 'px', top: `calc(50% - ${t / 2}px)`, borderRadius: t / 2 + 'px', background: c };
  const fill = pick(props.fill, FILLS, 'solid');
  const radius = shape === 'circle' ? '50%' : shape === 'pill' ? Math.round(h / 2) + 'px' : num(props.radius, 0, 540, 12) + 'px';
  const style: Record<string, string> = { top: '0', height: '100%', borderRadius: radius };
  if (fill === 'outline') style.boxShadow = `inset 0 0 0 ${t}px ${c}`;
  else if (fill === 'fade') style.background = `linear-gradient(90deg, ${c} 0%, ${c}00 100%)`;
  else style.background = c;
  return style;
}

function ShapeStage({ el }: StageProps) {
  return (
    <Region rect={fraction(el)} design={design(el)} opacity={num(el.props.opacity, 0.05, 1, 1)}>
      <div class="el-shape" style={shapeStyle(el.props, el.rect.h)} />
    </Region>
  );
}

const notLine = (p: Record<string, PropValue>) => p.shape !== 'line';

register({
  type: 'shape',
  label: 'Shape',
  blurb: 'A panel behind text, a frame, a divider',
  icon: '',
  tone: 'menu-ic-shape',
  size: { w: 560, h: 160 },
  min: { w: 8, h: 8 },
  avoidByDefault: true,
  named: true,
  defaults: { shape: 'box', fill: 'solid', color: '#9455FF', radius: 16, thickness: 4, opacity: 0.85 },
  fields: [
    {
      kind: 'pick',
      key: 'shape',
      label: 'Shape',
      options: [
        { value: 'box', label: 'Box' },
        { value: 'pill', label: 'Pill' },
        { value: 'circle', label: 'Circle' },
        { value: 'line', label: 'Line' },
      ],
    },
    {
      kind: 'pick',
      key: 'fill',
      label: 'Fill',
      hint: 'Fade runs from the colour on the left to clear on the right.',
      when: notLine,
      options: [
        { value: 'solid', label: 'Solid' },
        { value: 'outline', label: 'Outline' },
        { value: 'fade', label: 'Fade' },
      ],
    },
    { kind: 'swatches', key: 'color', label: 'Colour', options: COLORS },
    { kind: 'slider', key: 'radius', label: 'Rounded corners', min: 0, max: 160, step: 1, unit: 'px', when: (p) => (p.shape ?? 'box') === 'box' },
    {
      kind: 'slider',
      key: 'thickness',
      label: 'Thickness',
      min: 1,
      max: 48,
      step: 1,
      unit: 'px',
      when: (p) => p.shape === 'line' || p.fill === 'outline',
    },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.05, max: 1, step: 0.05, percent: true },
  ],
  Stage: ShapeStage,
});
