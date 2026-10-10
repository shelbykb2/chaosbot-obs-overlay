/* Which layout a /scene/ page shows, and the layers it cross-fades between. No DOM and no imports
   with code, so node --test runs it as is (test/scene-layers.test.ts). */

/** The layout id in /scene/<id>, or 'live'. Null for any other path. */
export function pageSceneId(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'scene' || parts.length !== 2) return null;
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
}

/** The layout to draw: the page's own, or the active one when the page follows the live layout. */
export function targetScene(pageId: string, activeSceneId: string | null): string | null {
  return pageId === 'live' ? activeSceneId : pageId;
}

export interface Layer {
  key: number;
  sceneId: string;
  /** Fades in. Off for the first layout a page draws, which simply appears. */
  fadeIn: boolean;
  leaving: boolean;
}

/** At most this many layouts fading out at once; a fast run of switches drops the oldest. */
export const MAX_LEAVING = 2;

/**
 * The layers after the layout to show became `sceneId`. The one on screen starts to leave and
 * the new one fades in over it. Same layout: nothing changes.
 */
export function nextLayers(layers: Layer[], sceneId: string | null, key: number): Layer[] {
  const top = layers.find((l) => !l.leaving);
  if ((top?.sceneId ?? null) === sceneId) return layers;
  const leaving = layers.filter((l) => l.leaving);
  if (top) leaving.push({ ...top, leaving: true });
  const out = leaving.slice(-MAX_LEAVING);
  if (sceneId !== null) out.push({ key, sceneId, fadeIn: !!top, leaving: false });
  return out;
}

/** The layers once the one with `key` has finished leaving. */
export function dropLayer(layers: Layer[], key: number): Layer[] {
  return layers.filter((l) => !(l.leaving && l.key === key));
}

/** Every feed the given element types need, sorted and without repeats. */
export function feedsOf(types: string[], feedsFor: (type: string) => string[] | undefined): string[] {
  const all = new Set<string>();
  for (const t of types) for (const f of feedsFor(t) ?? []) all.add(f);
  return [...all].sort();
}
