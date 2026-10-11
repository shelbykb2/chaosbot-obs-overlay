import { useEffect, useRef, useState } from 'preact/hooks';
import { openDescribe } from './describing';
import { addLayout, addTrigger, deleteLayout, editLayout, makeLive, removeTrigger, renameLayout, searchCategories } from './actions';
import type { Trigger } from './model';
import { get, scene, set, useStore } from './store';

/* Above the canvas: the layouts, which one is live, and what puts the one being edited live. */

function RenameBox(props: { id: string; name: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const done = (keep: boolean) => {
    if (keep && ref.current) renameLayout(props.id, ref.current.value);
    set({ renaming: null });
  };
  return (
    <input
      ref={ref}
      class="ly-rename"
      aria-label="Layout name"
      maxLength={60}
      defaultValue={props.name}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done(true);
        else if (e.key === 'Escape') done(false);
        e.stopPropagation();
      }}
    />
  );
}

export function LayoutStrip() {
  const st = useStore();
  const editing = scene().id;
  return (
    <div class="ly-strip" role="tablist" aria-label="Layouts">
      {st.doc.scenes.map((s) => {
        const live = s.id === st.doc.activeSceneId;
        if (st.renaming === s.id) return <RenameBox key={s.id} id={s.id} name={s.name} />;
        return (
          <button
            key={s.id}
            role="tab"
            class={'ly-tab' + (s.id === editing ? ' is-sel' : '')}
            aria-selected={s.id === editing}
            title="Double-click to rename"
            onClick={() => editLayout(s.id)}
            onDblClick={() => set({ renaming: s.id })}
          >
            <span class="ly-name">{s.name}</span>
            {live && <span class="ly-live">Live</span>}
            {st.draft?.id === s.id && <span class="ly-draft">Draft</span>}
          </button>
        );
      })}
      <button class="ly-new" onClick={addLayout}>
        <i class="ic">{''}</i>New layout
      </button>
      <button class="ly-new" onClick={() => openDescribe()} aria-expanded={st.describe.open && !st.describe.change}>
        <i class="ic">{''}</i>Describe a layout
      </button>
    </div>
  );
}

const triggerIcon = (t: Trigger) => (t.kind === 'game' ? '' : '');

function Picker(props: { close: () => void }) {
  const st = useStore();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) props.close();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && props.close();
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, []);

  const here = scene();
  // Where each game or category is listed now, so the picker can say it moves.
  const owner = (kind: Trigger['kind'], value: string) =>
    st.doc.scenes.find((s) => s.showFor.some((t) => t.kind === kind && t.value === value));
  const chip = (t: Trigger, note?: string) => {
    const at = owner(t.kind, t.value);
    const listed = at?.id === here.id;
    return (
      <button
        key={t.kind + t.value}
        class={'pk-chip' + (listed ? ' is-on' : '')}
        disabled={listed}
        title={at && !listed ? `Moves here from ${at.name}` : undefined}
        onClick={() => addTrigger(t)}
      >
        <i class="ic">{triggerIcon(t)}</i>
        <span>{t.label}</span>
        {note && <small>{note}</small>}
        {at && !listed && <small>in {at.name}</small>}
      </button>
    );
  };

  const cats = st.catQuery.trim() ? st.catResults : [];
  return (
    <div class="menu pk" role="dialog" aria-label="Goes live when" ref={ref}>
      <div class="pk-h">Games</div>
      <div class="pk-chips">
        {st.games.length ? (
          st.games.map((g) => chip({ kind: 'game', value: g.id, label: g.name }))
        ) : (
           <span class="pk-empty">Open a game, then pick it here. You can also match a Twitch category.</span>
        )}
      </div>
      <div class="pk-h">Twitch category</div>
      <div class="pk-chips">
        {st.category && chip({ kind: 'category', value: st.category.id, label: st.category.name }, 'now')}
      </div>
      <label class="pk-search">
        <i class="ic">{''}</i>
        <input
          placeholder="Just Chatting, Art, Music"
          value={st.catQuery}
          onInput={(e) => searchCategories((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>
      {cats.length > 0 && (
        <div class="pk-chips">
          {cats.filter((c) => c.id !== st.category?.id).map((c) => chip({ kind: 'category', value: c.id, label: c.name }))}
        </div>
      )}
    </div>
  );
}

export function LayoutBar() {
  const st = useStore();
  const [open, setOpen] = useState(false);
  const s = scene();
  const live = s.id === st.doc.activeSceneId;
  const close = () => {
    setOpen(false);
    if (get().catQuery) set({ catQuery: '', catResults: [] });
  };
  return (
    <div class="ly-bar">
      <span class="ly-when">Goes live when</span>
      {s.showFor.map((t) => (
        <span key={t.kind + t.value} class="ly-trig">
          <i class="ic">{triggerIcon(t)}</i>
          {t.label}
          <button aria-label={`Remove ${t.label}`} title="Remove" onClick={() => removeTrigger(t)}>
            <i class="ic">{''}</i>
          </button>
        </span>
      ))}
      <span class="add-wrap">
        <button class="ly-add" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
          <i class="ic">{''}</i>
          {s.showFor.length ? 'Add' : 'Pick a game or category'}
        </button>
        {open && <Picker close={close} />}
      </span>
      <span class="spacer" />
      {live ? (
        <span class="ly-is-live">
          <i class="ic">{''}</i>Live now
        </span>
      ) : (
        <button class="btn btn-sub" title="Stays live until you switch game or category" onClick={() => makeLive(s.id)}>
          <i class="ic">{''}</i>Make live now
        </button>
      )}
      <button class="icon-btn" title="Rename" aria-label={`Rename ${s.name}`} onClick={() => set({ renaming: s.id })}>
        <i class="ic">{''}</i>
      </button>
      <button class="icon-btn" title="Delete layout" aria-label={`Delete ${s.name}`} disabled={st.doc.scenes.length <= 1} onClick={() => deleteLayout(s.id)}>
        <i class="ic">{''}</i>
      </button>
    </div>
  );
}
