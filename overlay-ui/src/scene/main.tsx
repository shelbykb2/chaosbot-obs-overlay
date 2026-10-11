import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import '../shared/overlay.css';
import '../spotify/spotify.css';
import './scene.css';
import '../editor/kinds';
import { readDoc, type Doc, type El } from '../editor/model';
import { REGISTRY, typeOf } from '../editor/registry';
import { fromPlugin } from '../shared/env';
import { setFeeds, useHub } from '../shared/hub';
import { dropLayer, feedsOf, nextLayers, pageSceneId, targetScene, type Layer } from './layers';

/**
 * A layout as OBS shows it: /scene/<id> draws that layout, /scene/live the active one, fading to
 * the next when it changes. The layout comes from the hub (scene on connect and on every save,
 * scenePreview while the editor drags), so nothing here is ever written back.
 *
 * Served from the OBS plugin, the page starts from the plugin's saved copy of the layouts and
 * then follows ChaosBot's hub when ChaosBot is running.
 *
 * Elements draw with the same components as the editor's canvas, from the same registry, at
 * their 1920 x 1080 rects scaled to the window. No-go zones and hidden elements are not drawn.
 */

const PAGE_ID = pageSceneId(location.pathname) ?? 'live';
const FADE_MS = 450;

interface Preview {
  sceneId: string;
  elements: El[];
}

function readPreview(raw: unknown): Preview | null {
  const p = raw as { sceneId?: unknown; elements?: unknown } | null;
  if (!p || typeof p.sceneId !== 'string' || !Array.isArray(p.elements)) return null;
  const doc = readDoc({ scenes: [{ id: p.sceneId, name: '', elements: p.elements }] });
  return doc ? { sceneId: p.sceneId, elements: doc.scenes[0].elements } : null;
}

const drawn = (els: El[]) => els.filter((e) => !e.hidden && !!typeOf(e)?.Stage && !typeOf(e)?.editorOnly);

let nextKey = 1;

function SceneLayer(props: { layer: Layer; elements: El[] }) {
  const { layer } = props;
  const cls = 'sc-layer' + (layer.leaving ? ' is-out' : layer.fadeIn ? ' is-in' : '');
  return (
    <div class={cls}>
      {props.elements.map((el) => {
        const Stage = typeOf(el)!.Stage!;
        return <Stage key={el.id} el={el} playing live />;
      })}
    </div>
  );
}

function SceneOverlay() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);

  useHub(
    useMemo(
      () => ({
        scene(raw: unknown) {
          const next = readDoc((raw as { doc?: unknown } | null)?.doc);
          if (next) setDoc(next);
        },
        scenePreview: (raw: unknown) => setPreview(readPreview(raw)),
      }),
      [],
    ),
  );

  // The OBS plugin's copy draws the last layout ChaosBot sent it, so the overlay is up after an OBS
  // restart with ChaosBot closed. The hub's own layout, once it connects, wins.
  useEffect(() => {
    if (!fromPlugin()) return;
    fetch('/overlay/scenes.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((raw) => {
        const saved = readDoc((raw as { doc?: unknown } | null)?.doc);
        if (saved) setDoc((d) => d ?? saved);
      })
      .catch(() => {});
  }, []);

  const target = doc ? targetScene(PAGE_ID, doc.activeSceneId) : null;
  useEffect(() => {
    setLayers((ls) => nextLayers(ls, target, nextKey++));
  }, [target]);

  // A leaving layer goes once its fade has run.
  const leavingKeys = layers
    .filter((l) => l.leaving)
    .map((l) => l.key)
    .join();
  useEffect(() => {
    if (!leavingKeys) return;
    const keys = leavingKeys.split(',').map(Number);
    const t = window.setTimeout(() => setLayers((ls) => keys.reduce(dropLayer, ls)), FADE_MS);
    return () => clearTimeout(t);
  }, [leavingKeys]);

  const elementsOf = (sceneId: string): El[] => {
    if (preview && preview.sceneId === sceneId) return drawn(preview.elements);
    return drawn(doc?.scenes.find((s) => s.id === sceneId)?.elements ?? []);
  };

  const shown = layers.map((l) => ({ layer: l, elements: elementsOf(l.sceneId) }));
  // The spectrum and other feeds are sent only while something on the page draws them.
  const feeds = feedsOf(
    shown.flatMap((s) => s.elements.map((e) => e.type)),
    (t) => REGISTRY.get(t)?.feeds,
  ).join();
  useEffect(() => setFeeds(feeds ? feeds.split(',') : []), [feeds]);

  return (
    <>
      {shown.map((s) => (
        <SceneLayer key={s.layer.key} layer={s.layer} elements={s.elements} />
      ))}
    </>
  );
}

render(<SceneOverlay />, document.getElementById('overlay')!);
