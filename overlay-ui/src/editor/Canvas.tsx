import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { StageContext } from '../shared/Region';
import { addElement, dropImage, toggleEdge } from './actions';
import { bounds, dragBox, intersects, moveDelta, resizeBox, snapTargets, type Box, type Dir } from './geometry';
import { CANVAS, LIMITS, type El } from './model';
import { REGISTRY, typeOf } from './registry';
import { beginGesture, editEl, endGesture, get, live, scene, select, set, toast, useStore } from './store';

/* The 1920 x 1080 canvas, scaled to the column. The stage draws each element with the same
   component OBS uses, at full size, then scales as one layer. The edit layer above it is in
   percentages, so outlines, tags and handles keep their screen size at any width. */

const SNAP_PX = 7; // screen pixels
const DIRS: Dir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const STAGE = { w: CANVAS.w, h: CANVAS.h };

const pct = (r: Box) => ({
  left: (r.x / CANVAS.w) * 100 + '%',
  top: (r.y / CANVAS.h) * 100 + '%',
  width: (r.w / CANVAS.w) * 100 + '%',
  height: (r.h / CANVAS.h) * 100 + '%',
});

function targetsFor(skip: string[]) {
  return snapTargets(
    scene()
      .elements.filter((e) => !skip.includes(e.id) && !e.hidden)
      .map((e) => e.rect),
  );
}

/** Follows the pointer until it is released, wherever it goes. */
function track(move: (e: PointerEvent) => void, up: (e: PointerEvent) => void) {
  const end = (e: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    up(e);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

export function Canvas() {
  const st = useStore();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [draft, setDraft] = useState<Box | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [dropping, setDropping] = useState(false);

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Never 0: a collapsed pane would turn every pointer result into NaN.
  const s = Math.max(0.05, width / CANVAS.w);
  const els = scene().elements;
  const selSet = new Set(st.sel);
  const nogo = REGISTRY.get('nogo')!;

  const toCanvas = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };

  function startMove(e: PointerEvent, el: El) {
    if (get().tool === 'draw' || e.button !== 0) return;
    e.stopPropagation();
    box.current?.focus();
    let ids = get().sel;
    if (e.shiftKey || e.ctrlKey) {
      select(selSet.has(el.id) ? ids.filter((i) => i !== el.id) : [...ids, el.id]);
      return;
    }
    if (!selSet.has(el.id)) select((ids = [el.id]));
    const movers = scene().elements.filter((x) => ids.includes(x.id) && !x.locked);
    if (!movers.length) return;
    const start = toCanvas(e);
    const starts = new Map(movers.map((m) => [m.id, { ...m.rect }]));
    const b0 = bounds([...starts.values()]);
    const targets = targetsFor(ids);
    let moved = false;
    track(
      (ev) => {
        const p = toCanvas(ev);
        const dx0 = p.x - start.x;
        const dy0 = p.y - start.y;
        if (!moved) {
          if (Math.hypot(dx0 * s, dy0 * s) < 3) return;
          moved = true;
          beginGesture();
        }
        const { dx, dy, guides } = moveDelta(b0, dx0, dy0, get().snap && !ev.altKey ? targets : null, SNAP_PX / s);
        live((d) => {
          for (const [id, r] of starts) editEl(d, id, (x) => (x.rect = { ...r, x: r.x + dx, y: r.y + dy }));
        });
        set({ guides });
      },
      () => {
        if (moved) endGesture();
      },
    );
  }

  function startResize(e: PointerEvent, el: El, dir: Dir) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const r0 = { ...el.rect };
    const start = toCanvas(e);
    const min = typeOf(el)?.min ?? { w: LIMITS.minSide, h: LIMITS.minSide };
    const targets = targetsFor([el.id]);
    beginGesture();
    track(
      (ev) => {
        const p = toCanvas(ev);
        const { rect, guides } = resizeBox(r0, dir, p.x - start.x, p.y - start.y, {
          targets: get().snap && !ev.altKey ? targets : null,
          thr: SNAP_PX / s,
          aspect: ev.shiftKey ? r0.w / r0.h : null,
          minW: min.w,
          minH: min.h,
        });
        live((d) => editEl(d, el.id, (x) => (x.rect = rect)));
        set({ guides });
      },
      () => endGesture(),
    );
  }

  function startBackground(e: PointerEvent) {
    if (e.button !== 0) return;
    box.current?.focus();
    set({ addOpen: false });
    const a = toCanvas(e);
    if (get().tool === 'draw') {
      track(
        (ev) => setDraft(dragBox(a, toCanvas(ev))),
        (ev) => {
          setDraft(null);
          const r = dragBox(a, toCanvas(ev));
          if (r.w < 4 && r.h < 4) return;
          if (r.w < nogo.min.w || r.h < nogo.min.h) {
            toast(`Too small for a zone. Drag at least ${nogo.min.w} x ${nogo.min.h}.`);
            return;
          }
          set({ tool: 'select' });
          addElement('nogo', r);
        },
      );
      return;
    }
    const base = e.shiftKey ? get().sel : [];
    if (!e.shiftKey) select([]);
    track(
      (ev) => {
        const r = dragBox(a, toCanvas(ev));
        setMarquee(r);
        const hit = scene()
          .elements.filter((x) => intersects(x.rect, r))
          .map((x) => x.id);
        set({ sel: [...new Set([...base, ...hit])] });
      },
      () => setMarquee(null),
    );
  }

  const single = st.sel.length === 1 ? els.find((e) => e.id === st.sel[0]) : undefined;
  const multi = st.sel.length > 1 ? els.filter((e) => selSet.has(e.id)) : [];

  return (
    <div
      class={'canvas' + (dropping ? ' is-drop' : '') + (st.tool === 'draw' ? ' is-draw' : '') + (st.showNoGo ? '' : ' hide-nogo') + (st.still ? '' : ' is-blank')}
      ref={box}
      tabIndex={0}
      aria-label="Overlay canvas, 1920 by 1080"
      onPointerDown={(e) => startBackground(e as PointerEvent)}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) dropImage(file, toCanvas(e as unknown as PointerEvent));
      }}
    >
      {dropping && (
        <div class="cv-drop" role="status">
          <i class="ic">{''}</i>Drop to add the picture here
        </div>
      )}
      {st.stillLive && (
        <div class="cv-live" aria-hidden="true">
          <span class="cv-live-dot" />
          OBS
        </div>
      )}
      {!st.still && (
        <div class="cv-empty" role="status">
          <i class="ic">{''}</i>
          <b>Open a game to see it here</b>
          <span>Your overlay works either way. This is only the picture behind it while you edit.</span>
        </div>
      )}

      <div class="stage" style={{ transform: `scale(${s})` }}>
        {st.still && <img class="still" src={st.still} alt="" />}
        <div id="overlay">
          <StageContext.Provider value={STAGE}>
            {els.map((el) => {
              const Stage = typeOf(el)?.Stage;
              return Stage && !el.hidden ? <Stage key={el.id} el={el} playing={st.playing} /> : null;
            })}
          </StageContext.Provider>
        </div>
      </div>

      <div class="edit-layer">
        {els.map((el, i) => (
          <ElBox
            key={el.id}
            el={el}
            z={el.type === 'nogo' ? 500 + i : i + 1}
            sel={selSet.has(el.id)}
            handles={single === el && !el.locked}
            onDown={(e) => startMove(e, el)}
            onHandle={(e, d) => startResize(e, el, d)}
          />
        ))}
        {multi.length > 0 && (
          <div class="multi" style={pct(bounds(multi.map((e) => e.rect)))}>
            <span class="el-tag">{multi.length} selected</span>
          </div>
        )}
        {st.chaosSel && st.chaos && <Edges edges={st.chaos.edges} valid={st.chaos.validEdges} />}
        {draft && <div class="draft" style={pct(draft)} />}
        {marquee && <div class="marquee" style={pct(marquee)} />}
      </div>

      <div class="guides">
        {st.guides.map((g, i) =>
          g.axis === 'x' ? (
            <i key={i} class="v" style={{ left: (g.at / CANVAS.w) * 100 + '%' }} />
          ) : (
            <i key={i} class="h2" style={{ top: (g.at / CANVAS.h) * 100 + '%' }} />
          ),
        )}
      </div>

      <div class={'toast' + (st.toast ? ' is-on' : '')} role="status">
        {st.toast}
      </div>
    </div>
  );
}

const EDGE_LABEL: Record<string, string> = { left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' };

/** With Chaos selected: the sides he can come in from. Click one to turn it on or off. */
function Edges(props: { edges: string[]; valid: string[] }) {
  return (
    <>
      {props.valid.map((e) => {
        const on = props.edges.includes(e);
        return (
          <button
            key={e}
            class={'cv-edge cv-edge-' + e + (on ? ' is-on' : '')}
            aria-pressed={on}
            title={on ? `Chaos comes in from the ${e}. Click to stop.` : `Click so Chaos can come in from the ${e}.`}
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={() => toggleEdge(e)}
          >
            <span>
              {EDGE_LABEL[e] ?? e}
              {on ? '' : ', off'}
            </span>
          </button>
        );
      })}
    </>
  );
}

function ElBox(props: {
  el: El;
  z: number;
  sel: boolean;
  handles: boolean;
  onDown: (e: PointerEvent) => void;
  onHandle: (e: PointerEvent, d: Dir) => void;
}) {
  const { el } = props;
  const T = typeOf(el);
  const zone = !!T?.editorOnly;
  const r = el.rect;
  // Tags sit above the box, or below it when the box touches the top of the canvas.
  const below = r.y < 54;
  const cls =
    'el ' +
    (zone ? 'el--zone' : 'el--w') +
    (props.sel ? ' is-sel' : '') +
    (el.hidden ? ' is-off' : '') +
    (el.locked ? ' is-locked' : '') +
    (T ? '' : ' is-unknown') +
    (!zone && el.avoid && !el.hidden ? ' is-avoid' : '');
  return (
    <div class={cls} style={{ ...pct(r), zIndex: props.z }} onPointerDown={(e) => props.onDown(e as PointerEvent)}>
      <div class="el-box" />
      {zone ? (
        <span class="el-tag">
          <i class="ic">{''}</i>
          {el.name}
          {el.props.laugh === true && (
            <i class="ic" title="Laugh toward">
              {''}
            </i>
          )}
        </span>
      ) : (
        <>
          <span class={'el-tag' + (below ? ' is-below' : '')}>
            {el.locked && <i class="ic">{''}</i>}
            {el.name} <small>{r.w} x {r.h}</small>
          </span>
          <span class={'el-avoid' + (below ? ' is-below' : '')}>
            <i class="ic">{''}</i>Chaos avoids
          </span>
          <div class="el-off">{T ? 'Hidden on stream' : 'Made by a newer ChaosBot'}</div>
        </>
      )}
      {props.handles && DIRS.map((d) => <i key={d} class="h" data-h={d} onPointerDown={(e) => props.onHandle(e as PointerEvent, d)} />)}
    </div>
  );
}
