import { useEffect, useRef } from 'preact/hooks';
import { addElement, reorder, selectChaos, setFlag } from './actions';
import chaosHead from './chaos-head.png';
import type { El } from './model';
import { REGISTRY, typeOf, type ElementType } from './registry';
import { scene, select, set, useStore } from './store';

/* The Elements card: the Add menu and the list, front to back (the top row paints last). */

export function TypeIcon(props: { T?: ElementType }) {
  return (
    <span class={'menu-ic ' + (props.T?.tone ?? 'menu-ic-unknown')}>
      <i class="ic">{props.T?.icon ?? ''}</i>
    </span>
  );
}

function AddMenu() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) set({ addOpen: false });
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && set({ addOpen: false });
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, []);
  const els = scene().elements;
  return (
    <div class="menu" role="menu" ref={ref}>
      {[...REGISTRY.values()].map((T) => {
        const has = T.single && els.some((e) => e.type === T.type);
        return (
          <button key={T.type} class="menu-i" role="menuitem" onClick={() => addElement(T.type)}>
            <TypeIcon T={T} />
            <span>
              <b>{T.label}</b>
              <small>{has ? 'Already in this layout. Selects it.' : T.blurb}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Row(props: { el: El; index: number; count: number; sel: boolean }) {
  const { el } = props;
  const T = typeOf(el);
  const r = el.rect;
  const badge = el.hidden ? (
    <span class="badge badge-off">Hidden</span>
  ) : el.avoid ? (
    <span class="badge badge-nogo" title="Chaos stays out of this">
      <i class="ic">{''}</i>No-go
    </span>
  ) : null;
  return (
    <li class={'layer' + (props.sel ? ' is-sel' : '')} role="option" aria-selected={props.sel} onClick={() => select([el.id])}>
      <TypeIcon T={T} />
      <span class="layer-txt">
        <b>{el.name}</b>
        <small>
          {r.w} x {r.h} at {r.x}, {r.y}
        </small>
      </span>
      {badge}
      <span class="order" onClick={(e) => e.stopPropagation()}>
        <button title="Forward (])" disabled={props.index === props.count - 1} onClick={() => reorder(el.id, 1)}>
          {'▲'}
        </button>
        <button title="Back ([)" disabled={props.index === 0} onClick={() => reorder(el.id, -1)}>
          {'▼'}
        </button>
      </span>
      {!T?.editorOnly && (
        <button
          class="eye"
          title={el.hidden ? 'Show on stream' : 'Hide on stream'}
          aria-label={el.hidden ? `Show ${el.name} on stream` : `Hide ${el.name} on stream`}
          onClick={(e) => {
            e.stopPropagation();
            setFlag(el.id, 'hidden', !el.hidden);
          }}
        >
          <i class="ic">{el.hidden ? '' : ''}</i>
        </button>
      )}
    </li>
  );
}

/** Chaos is in every layout and is not one of its elements, so his row is pinned above them. */
function ChaosRow() {
  const st = useStore();
  const c = st.chaos;
  const style = c?.presentation === 'full' ? 'Full' : 'Peek';
  return (
    <li class={'layer layer-chaos' + (st.chaosSel ? ' is-sel' : '')} role="option" aria-selected={st.chaosSel} onClick={selectChaos}>
      <span class="menu-ic menu-ic-chaos">
        <img src={chaosHead} alt="" />
      </span>
      <span class="layer-txt">
        <b>Chaos</b>
        <small>{c ? `${style}, ${c.muted ? 'muted' : 'with sound'}` : 'Pops in when chat says hello'}</small>
      </span>
      <span class="badge badge-all" title="The same Chaos in every layout">
        Every layout
      </span>
    </li>
  );
}

export function Elements() {
  const st = useStore();
  const els = scene().elements;
  const sel = new Set(st.sel);
  return (
    <div class="card">
      <div class="card-head card-head-row">
        <div class="card-title">Elements</div>
        <div class="add-wrap">
          <button class="btn btn-accent" aria-haspopup="menu" aria-expanded={st.addOpen} onClick={() => set({ addOpen: !st.addOpen })}>
            <i class="ic">{''}</i>Add
          </button>
          {st.addOpen && <AddMenu />}
        </div>
      </div>
      <ul class="layers" role="listbox" aria-label="Elements, front to back" aria-multiselectable="true">
         {st.chaos && <ChaosRow />}
         {els.length === 0 && <li class="layers-empty">This layout is empty. Add your first element.</li>}
        {[...els].reverse().map((el) => {
          const i = els.indexOf(el);
          return <Row key={el.id} el={el} index={i} count={els.length} sel={sel.has(el.id)} />;
        })}
      </ul>
    </div>
  );
}
