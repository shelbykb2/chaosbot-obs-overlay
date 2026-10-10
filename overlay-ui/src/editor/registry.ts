import type { FunctionComponent } from 'preact';
import type { El, PropValue } from './model';

/* The element registry. One entry per element type: what the Add menu and the list show, the
   fields the properties panel is built from, and the component drawn on the stage. Adding an
   element type is one entry plus its component; the canvas, the list and the panel need no
   change. */

/** Shown only while this is true of the element's props (a corner slider only for boxes). */
type When = { when?: (props: Record<string, PropValue>) => boolean };

export type Field = When &
  (
    | { kind: 'toggle'; key: string; label: string; hint?: string }
    | {
        kind: 'pick';
        key: string;
        label: string;
        hint?: string;
        options: { value: string; label: string }[];
        /** Called after a choice, with the element's props as they were (a sound plays). */
        onPick?: (value: string, props: Record<string, PropValue>) => void;
      }
    | { kind: 'swatches'; key: string; label: string; hint?: string; auto?: string; options: { value: string; name: string }[] }
    | { kind: 'slider'; key: string; label: string; hint?: string; min: number; max: number; step: number; percent?: boolean; unit?: string }
    | { kind: 'text'; key: string; label: string; hint?: string; max: number; placeholder?: string; /** One line instead of three. */ line?: boolean }
    | { kind: 'image'; key: string; label: string; hint?: string }
    /** A stored sound file (MP3, OGG or WAV), with a play button. */
    | { kind: 'sound'; key: string; label: string; hint?: string }
    /** "Start over": sets the prop to now (ISO 8601); ChaosBot counts from then. */
    | { kind: 'goalReset'; key: string; label: string; hint?: string }
    /** One button per alert kind; fires a test alert in the editor and in OBS. */
    | { kind: 'alertTest'; key: string; label: string; hint?: string }
    /** Shown when Twitch has not given ChaosBot the follower permission yet. */
    | { kind: 'followsAccess'; key: string; label: string; hint?: string }
  );

export interface StageProps {
  el: El;
  /** The sample track is playing (the Preview button). */
  playing: boolean;
  /** Drawn in OBS (/scene/): real data from the hub instead of samples. */
  live?: boolean;
}

export interface ElementType {
  type: string;
  /** Name in the Add menu and the properties head. */
  label: string;
  /** One line under the label. */
  blurb: string;
  /** Segoe Fluent Icons glyph. */
  icon: string;
  /** Icon tile colour class (editor.css). */
  tone: string;
  /** At most one per layout. Add selects the one already there. */
  single?: boolean;
  size: { w: number; h: number };
  min: { w: number; h: number };
  avoidByDefault: boolean;
  /** Never drawn in OBS (a no-go zone). The hide switch and the Chaos switch do not apply. */
  editorOnly?: boolean;
  /** Whether the element has a name field; others show the label. */
  named?: boolean;
  defaults: Record<string, PropValue>;
  fields: Field[];
  /** Hub feeds the element needs in OBS beyond the defaults (Feeds on the hub). */
  feeds?: string[];
  /** Drawn on the 1920 x 1080 stage, positioned by the component itself. */
  Stage?: FunctionComponent<StageProps>;
}

export const REGISTRY = new Map<string, ElementType>();

export function register(t: ElementType) {
  // Chaos-only extensions are preserved in imported documents but never offered or drawn by this host.
  if (t.type === 'nogo' || t.type === 'commandFeed' || t.type === 'bitsMeter') return;
  REGISTRY.set(t.type, t);
}

export function typeOf(el: El): ElementType | undefined {
  return REGISTRY.get(el.type);
}
