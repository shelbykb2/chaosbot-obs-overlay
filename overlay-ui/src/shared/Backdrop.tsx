export type BackdropMode = 'art' | 'glass' | 'solid';

/**
 * The card's surface, drawn inside a clipped box (.ov-box). Reads the palette from CSS
 * custom properties set on an ancestor (see paletteVars).
 *
 * - art:   the cover, pre-blurred once, under a tint dark enough for white text.
 * - glass: frosted glass. A paler pre-blurred wash of the cover over a see-through tint, frost
 *          veil, grain, a lit rim and a slow light sweep. Nothing is blurred live: a page in
 *          OBS has nothing behind it to blur, and live blur costs every frame.
 * - solid: one flat colour from the palette.
 *
 * Motion (aurora drift, light sweep) is CSS keyframes on transform only, and only runs while the
 * card has .is-live (playing, visible, motion allowed).
 */
export function Backdrop(props: { mode: BackdropMode }) {
  const m = props.mode;
  return (
    <div class={'ov-box bd bd--' + m}>
      {m !== 'solid' && <div class="bd-art" />}
      {m !== 'solid' && (
        <div class="bd-aurora">
          <i class="bd-blob bd-blob--a" />
          <i class="bd-blob bd-blob--b" />
        </div>
      )}
      <div class="bd-tint" />
      {m === 'glass' && <div class="bd-frost" />}
      {m === 'glass' && (
        <div class="bd-sweep">
          <i />
        </div>
      )}
      <div class="bd-grain" />
      <div class="bd-rim" />
    </div>
  );
}
