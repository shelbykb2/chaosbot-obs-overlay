import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { imageUrl, isSoundName } from '../shared/images';
import { playSound } from '../shared/sounds';
import { duplicate, openSettings, pickImage, pickSound, reconnectTwitch, remove, rename, reorder, setChaos, setFlag, setProp, setRect, testAlert } from './actions';
import chaosHead from './chaos-head.png';
import { TypeIcon } from './ElementList';
import { LIMITS, type El } from './model';
import { typeOf, type Field } from './registry';
import { scene, selected, useStore } from './store';

/* The properties panel. Built from the selected element's registry entry: its fields, then size
   and position, then the actions. */

function Sec(props: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <div class="p-sec">
      <span class="p-label">{props.label}</span>
      {props.children}
      {props.hint && <span class="p-hint">{props.hint}</span>}
    </div>
  );
}

function Switch(props: { on: boolean; title: string; hint?: string; onChange: (on: boolean) => void }) {
  return (
    <div class="row">
      <div class="row-txt">
        <b>{props.title}</b>
        {props.hint && <small>{props.hint}</small>}
      </div>
      <button class="switch" role="switch" aria-checked={props.on} aria-label={props.title} onClick={() => props.onChange(!props.on)} />
    </div>
  );
}

function FieldView(props: { el: El; f: Field }) {
  const { el, f } = props;
  const v = el.props[f.key];
  switch (f.kind) {
    case 'toggle':
      return <Switch on={v === true} title={f.label} hint={f.hint} onChange={(on) => setProp(el.id, f.key, on)} />;
    case 'pick':
      return (
        <Sec label={f.label} hint={f.hint}>
          <div class="seg-pick" role="radiogroup" aria-label={f.label}>
            {f.options.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={v === o.value}
                onClick={() => {
                  setProp(el.id, f.key, o.value);
                  f.onPick?.(o.value, el.props);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Sec>
      );
    case 'swatches':
      return (
        <Sec label={f.label} hint={f.hint}>
          <div class="swatches" role="radiogroup" aria-label={f.label}>
            {f.auto && (
              <button class="sw sw-auto" role="radio" aria-checked={v === f.auto} onClick={() => setProp(el.id, f.key, f.auto!)}>
                <i />
                Auto
              </button>
            )}
            {f.options.map((o) => (
              <button
                key={o.value}
                class="sw"
                role="radio"
                aria-checked={typeof v === 'string' && v.toLowerCase() === o.value.toLowerCase()}
                aria-label={o.name}
                title={o.name}
                style={{ background: o.value }}
                onClick={() => setProp(el.id, f.key, o.value)}
              />
            ))}
          </div>
        </Sec>
      );
    case 'slider': {
      const n = typeof v === 'number' ? v : f.max;
      return (
        <Sec label={f.label} hint={f.hint}>
          <div class="slider-row">
            <input
              type="range"
              min={f.min}
              max={f.max}
              step={f.step}
              value={n}
              aria-label={f.label}
              onInput={(e) => setProp(el.id, f.key, +(e.target as HTMLInputElement).value, 'slider:' + el.id + f.key)}
            />
            <output>{f.percent ? Math.round(n * 100) + '%' : n + (f.unit ?? '')}</output>
          </div>
        </Sec>
      );
    }
    case 'text':
      return (
        <Sec label={f.label} hint={f.hint}>
          <textarea
            class={'text-in text-area' + (f.line ? ' is-line' : '')}
            rows={f.line ? 1 : 3}
            maxLength={f.max}
            placeholder={f.placeholder}
            aria-label={f.label}
            value={typeof v === 'string' ? v : ''}
            onInput={(e) => setProp(el.id, f.key, (e.target as HTMLTextAreaElement).value, 'text:' + el.id + f.key)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </Sec>
      );
    case 'image':
      return <ImageField el={el} f={f} />;
    case 'sound':
      return <SoundField el={el} f={f} />;
    case 'goalReset':
      return (
        <Sec label={f.label} hint={f.hint}>
          <div class="goal-reset">
            <span>{since(v)}</span>
            <button class="btn" onClick={() => setProp(el.id, f.key, new Date().toISOString())}>
              <i class="ic">{''}</i>
              Start over
            </button>
          </div>
        </Sec>
      );
    case 'alertTest':
      return (
        <Sec label={f.label} hint={f.hint}>
          <div class="alert-tests">
            {ALERT_TESTS.map(([kind, label]) => (
              <button key={kind} class="btn" onClick={() => testAlert(kind)}>
                {label}
              </button>
            ))}
          </div>
        </Sec>
      );
    case 'followsAccess':
      return <FollowsAccess f={f} />;
  }
}

const ALERT_TESTS: [string, string][] = [
  ['follow', 'Follow'],
  ['sub', 'Sub'],
  ['resub', 'Resub'],
  ['gift', 'Gift'],
  ['bits', 'Bits'],
  ['raid', 'Raid'],
];

function since(v: unknown): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return 'Counting since you added it';
  return 'Counting since ' + new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function FollowsAccess(props: { f: Extract<Field, { kind: 'followsAccess' }> }) {
  // Only when ChaosBot has said follows are off; unknown (a plain browser) shows nothing.
  if (useStore().follows !== false) return null;
  return (
    <div class="p-sec follows-access">
      <b>{props.f.label}</b>
      {props.f.hint && <span class="p-hint">{props.f.hint}</span>}
      <button class="btn btn-accent" onClick={reconnectTwitch}>
        <i class="ic">{''}</i>
        Sign in to Twitch again
      </button>
    </div>
  );
}

function SoundField(props: { el: El; f: Extract<Field, { kind: 'sound' }> }) {
  const { el, f } = props;
  const input = useRef<HTMLInputElement>(null);
  const busy = Object.values(useStore().uploads).includes(el.id + '\n' + f.key);
  const file = el.props[f.key];
  const has = isSoundName(file);
  const volume = typeof el.props.volume === 'number' ? el.props.volume : 0.6;
  return (
    <Sec label={f.label} hint={f.hint}>
      <div class="img-field">
        <button class="btn" disabled={!has} aria-label="Play the sound" title="Play" onClick={() => playSound('custom', file, volume, false)}>
          <i class="ic">{''}</i>
        </button>
        <button class="btn" disabled={busy} onClick={() => input.current?.click()}>
          <i class="ic">{busy ? '' : ''}</i>
          {busy ? 'Adding' : has ? 'Change sound' : 'Choose a sound'}
        </button>
        <input
          ref={input}
          type="file"
          accept="audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav"
          hidden
          onChange={(e) => {
            const t = e.target as HTMLInputElement;
            const picked = t.files?.[0];
            if (picked) pickSound(el.id, f.key, picked);
            t.value = '';
          }}
        />
      </div>
    </Sec>
  );
}

function ImageField(props: { el: El; f: Extract<Field, { kind: 'image' }> }) {
  const { el, f } = props;
  const input = useRef<HTMLInputElement>(null);
  const busy = Object.values(useStore().uploads).includes(el.id);
  const src = imageUrl(el.props[f.key], false);
  return (
    <Sec label={f.label} hint={f.hint}>
      <div class="img-field">
        <span class={'img-thumb' + (src ? '' : ' is-empty')}>{src ? <img src={src} alt="" /> : <i class="ic">{''}</i>}</span>
        <button class="btn" disabled={busy} onClick={() => input.current?.click()}>
          <i class="ic">{busy ? '' : ''}</i>
          {busy ? 'Adding' : src ? 'Change picture' : 'Choose a picture'}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(e) => {
            const t = e.target as HTMLInputElement;
            const file = t.files?.[0];
            if (file) pickImage(el.id, file);
            t.value = '';
          }}
        />
      </div>
    </Sec>
  );
}

function CoordinateInput(props: {value:number;disabled:boolean;commit:(value:number)=>void}) {
  const [text,setText]=useState(String(props.value));
  useEffect(()=>setText(String(props.value)),[props.value]);
  return <input type="number" value={text} disabled={props.disabled}
    onInput={e=>setText(e.currentTarget.value)}
    onBlur={()=>{const n=Math.round(Number(text));if(text.trim()&&Number.isFinite(n)&&n!==props.value)props.commit(n);setText(String(props.value));}}
    onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}} />;
}

function Nums(props: { el: El }) {
  const r = props.el.rect;
  const keys = ['x', 'y', 'w', 'h'] as const;
  return (
    <Sec label="Size and position (px)">
      <div class="nums">
        {keys.map((k) => (
          <label key={k} class="num">
            <span>{k.toUpperCase()}</span>
            <CoordinateInput
              key={props.el.id+':'+k}
              value={r[k]}
              disabled={props.el.locked}
              commit={n=>setRect(props.el.id,k,n)}
            />
          </label>
        ))}
      </div>
    </Sec>
  );
}

function Actions(props: { ids: string[]; canDuplicate: boolean; order?: { id: string; index: number; count: number } }) {
  const o = props.order;
  return (
    <div class="p-actions">
      {props.canDuplicate && (
        <button class="btn" onClick={() => duplicate(props.ids)}>
          <i class="ic">{''}</i>Duplicate
        </button>
      )}
      {o && (
        <>
          <button class="btn" disabled={o.index === 0} onClick={() => reorder(o.id, -1)}>
            <i class="ic">{''}</i>Back
          </button>
          <button class="btn" disabled={o.index === o.count - 1} onClick={() => reorder(o.id, 1)}>
            <i class="ic">{''}</i>Forward
          </button>
        </>
      )}
      <button class="btn btn-danger" onClick={() => remove(props.ids)}>
        <i class="ic">{''}</i>Delete
      </button>
    </div>
  );
}

function One(props: { el: El }) {
  const { el } = props;
  const T = typeOf(el);
  const els = scene().elements;
  const order = { id: el.id, index: els.indexOf(el), count: els.length };
  if (!T) {
    return (
      <>
        <div class="p-head">
          <TypeIcon />
          <div>
            <b>{el.name}</b>
            <small>A newer ChaosBot made this. It stays as it is here and still shows in OBS.</small>
          </div>
        </div>
        <Nums el={el} />
        <Actions ids={[el.id]} canDuplicate={false} order={order} />
      </>
    );
  }
  return (
    <>
      <div class="p-head">
        <TypeIcon T={T} />
        <div>
          <b>{T.label}</b>
          <small>{T.blurb}</small>
        </div>
      </div>
      {T.named && (
        <Sec label="Name" hint="Only you see this.">
          <input
            class="text-in"
            value={el.name}
            maxLength={LIMITS.maxName}
            aria-label="Name"
            onInput={(e) => rename(el.id, (e.target as HTMLInputElement).value)}
          />
        </Sec>
      )}
      {!T.editorOnly && (
        <>
          <Switch
            on={!el.hidden}
            title="Show on stream"
            hint="Off hides it in OBS. It stays here so you can turn it back on."
            onChange={(on) => setFlag(el.id, 'hidden', !on)}
          />
        </>
      )}
      {T.fields
        .filter((f) => !f.when || f.when(el.props))
        .map((f) => (
          <FieldView key={f.key} el={el} f={f} />
        ))}
      <Nums el={el} />
      <Switch
        on={el.locked}
        title="Lock in place"
        hint="Drags and the arrow keys leave it where it is."
        onChange={(on) => setFlag(el.id, 'locked', on)}
      />
      <Actions ids={[el.id]} canDuplicate={!T.single} order={order} />
    </>
  );
}

const EDGE_NAME: Record<string, string> = { left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' };

function ChaosProps() {
  const c = useStore().chaos;
  if (!c) {
    return (
      <div class="p-head">
        <span class="menu-ic menu-ic-chaos">
          <img src={chaosHead} alt="" />
        </span>
        <div>
          <b>Chaos</b>
          <small>His settings load with ChaosBot.</small>
        </div>
      </div>
    );
  }
  const edges = c.validEdges.filter((e) => c.edges.includes(e)).map((e) => EDGE_NAME[e] ?? e);
  return (
    <>
      <div class="p-head">
        <span class="menu-ic menu-ic-chaos">
          <img src={chaosHead} alt="" />
        </span>
        <div>
          <b>Chaos</b>
          <small>The same in every layout. He keeps out of your no-go areas.</small>
        </div>
      </div>
      <Sec label="Style" hint={c.presentation === 'full' ? 'Walks on from any side you allow.' : 'Leans in from the side of the screen.'}>
        <div class="seg-pick" role="radiogroup" aria-label="Style">
          <button role="radio" aria-checked={c.presentation !== 'full'} onClick={() => setChaos({ presentation: 'peek' })}>
            Peek
          </button>
          <button role="radio" aria-checked={c.presentation === 'full'} onClick={() => setChaos({ presentation: 'full' })}>
            Full
          </button>
        </div>
      </Sec>
      <Sec label="Comes in from" hint="Click the edges on the canvas to choose.">
        <span class="p-edges">{edges.join(', ') || 'Any side'}</span>
      </Sec>
      <Switch on={c.muted} title="Muted" hint="No sound from Chaos on stream." onChange={(on) => setChaos({ muted: on })} />
      <div class="p-actions">
        <button class="btn" onClick={openSettings}>
          <i class="ic">{''}</i>More in Chaos settings
        </button>
      </div>
    </>
  );
}

export function Props() {
  const st = useStore();
  const sel = selected();
  return (
    <div class="card props">
      {st.chaosSel && <ChaosProps />}
      {!st.chaosSel && sel.length === 0 && (
        <div class="empty-props">
          <i class="ic">{''}</i>
          <div>
            <b>Select an element</b>
            <div class="p-hint">Click something on the canvas or in the list. Drag on an empty spot to select several.</div>
          </div>
        </div>
      )}
      {sel.length === 1 && <One key={sel[0].id} el={sel[0]} />}
      {sel.length > 1 && (
        <>
          <div class="p-head">
            <span class="menu-ic menu-ic-unknown">
              <i class="ic">{''}</i>
            </span>
            <div>
              <b>{sel.length} selected</b>
              <small>Drag any of them to move them together.</small>
            </div>
          </div>
          <Actions ids={sel.map((e) => e.id)} canDuplicate={sel.some((e) => !typeOf(e)?.single)} />
        </>
      )}
    </div>
  );
}
