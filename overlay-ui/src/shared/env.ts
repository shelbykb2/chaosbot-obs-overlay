import { useEffect, useState } from 'preact/hooks';

const query = new URLSearchParams(location.search);

/** The port the OBS plugin serves its copy of the overlay on. */
export const PLUGIN_PORT = '5260';

/**
 * Where ChaosBot's hub lives. Pages served by ChaosBot use their own origin; pages served from
 * the OBS plugin's copy reach ChaosBot on its fixed local port (the hub allows that origin).
 */
export function chaosOrigin(): string {
  return location.port === PLUGIN_PORT ? 'http://127.0.0.1:5051' : '';
}

/** True on the OBS plugin's copy of a page, which keeps drawing when ChaosBot is closed. */
export function fromPlugin(): boolean {
  return location.port === PLUGIN_PORT;
}

/** Query string of the page, read once. */
export function param(name: string): string | null {
  return query.get(name);
}

/**
 * True while the page can be seen: the document is not hidden and OBS has not reported the
 * source as hidden. OBS fires obsSourceVisibleChanged on its browser sources; elsewhere the
 * event never arrives and only the document state counts.
 */
export function useVisible(): boolean {
  const [docVisible, setDocVisible] = useState(!document.hidden);
  const [obsVisible, setObsVisible] = useState(true);
  useEffect(() => {
    const onDoc = () => setDocVisible(!document.hidden);
    const onObs = (ev: Event) => {
      const d = (ev as CustomEvent<{ visible?: boolean }>).detail;
      if (d && typeof d.visible === 'boolean') setObsVisible(d.visible);
    };
    document.addEventListener('visibilitychange', onDoc);
    window.addEventListener('obsSourceVisibleChanged', onObs);
    return () => {
      document.removeEventListener('visibilitychange', onDoc);
      window.removeEventListener('obsSourceVisibleChanged', onObs);
    };
  }, []);
  return docVisible && obsVisible;
}

/** prefers-reduced-motion, or ?reduced=1 to preview it. */
export function useReducedMotion(): boolean {
  const forced = param('reduced');
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [reduced, setReduced] = useState(forced !== null ? forced === '1' : !!media?.matches);
  useEffect(() => {
    if (forced !== null || !media) return;
    const on = () => setReduced(media.matches);
    media.addEventListener('change', on);
    return () => media.removeEventListener('change', on);
  }, []);
  return reduced;
}
