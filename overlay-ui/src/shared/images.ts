/* Where an Image element's picture is loaded from. ChaosBot stores each picture once, named by
   its SHA-256 (OverlayImageStore), and serves it twice: to OBS at /overlay/images/<name> on the
   overlay port, and to the editor's WebView2 from its own virtual host (sent in init). */

const NAME = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

/** OBS pages: same origin as the page. */
const OBS_BASE = '/overlay/images/';

let editorBase = '';
// Development in a plain browser: pictures stay in the page as object URLs.
const devUrls = new Map<string, string>();

export function isImageName(v: unknown): v is string {
  return typeof v === 'string' && NAME.test(v);
}

export function setEditorImageBase(base: string) {
  editorBase = /^https:\/\/[a-z0-9.-]+\/$/.test(base) || base === 'http://127.0.0.1:5260/overlay/images/' ? base : '';
}

export function addDevImage(name: string, url: string) {
  devUrls.set(name, url);
}

/** The URL for a stored picture, or null when the name is not one ChaosBot could have made. */
export function imageUrl(name: unknown, live: boolean): string | null {
  if (!isImageName(name)) return null;
  if (live) return OBS_BASE + name;
  return devUrls.get(name) ?? (editorBase ? editorBase + name : null);
}

/* Alert sounds live in the same store (OverlaySoundStore names): OBS gets them at /overlay/sounds/<name>,
   the editor from the same virtual host as pictures. */

const SOUND = /^[0-9a-f]{64}\.(mp3|ogg|wav)$/;

export function isSoundName(v: unknown): v is string {
  return typeof v === 'string' && SOUND.test(v);
}

/** The URL for a stored sound, or null when the name is not one ChaosBot could have made. */
export function soundUrl(name: unknown, live: boolean): string | null {
  if (!isSoundName(name)) return null;
  if (live) return '/overlay/sounds/' + name;
  return devUrls.get(name) ?? (editorBase ? editorBase.replace('/images/','/sounds/') + name : null);
}
