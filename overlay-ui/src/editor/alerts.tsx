import { useEffect, useRef, useState } from 'preact/hooks';
import { ALERT_KINDS, fraction, headline, readAlert, readGoal, sampleAlert, wanted, type AlertKind, type TwitchAlert } from '../shared/alerts';
import { useHub } from '../shared/hub';
import { imageUrl } from '../shared/images';
import { Region } from '../shared/Region';
import { playSound } from '../shared/sounds';
import '../shared/alerts.css';
import { COLORS } from './basics';
import { CANVAS, type El, type PropValue } from './model';
import { register, type StageProps } from './registry';

/* The alert box and the goal bar. Alerts queue and show one at a time: in, hold, out, with one
   timer per step and CSS transitions, so nothing runs between alerts. In the editor the box shows
   a sample alert, and Preview plays the samples in turn. */

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v: PropValue | undefined, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const accentOf = (p: Record<string, PropValue>) => (typeof p.accent === 'string' && HEX.test(p.accent) ? p.accent : '#9455FF');
const fractionRect = (el: El) => ({ x: el.rect.x / CANVAS.w, y: el.rect.y / CANVAS.h, w: el.rect.w / CANVAS.w, h: el.rect.h / CANVAS.h });

const KIND_ICON: Record<AlertKind, string> = {
  follow: 'M10 16.5s-6.5-3.8-6.5-8.4A3.6 3.6 0 0 1 10 6a3.6 3.6 0 0 1 6.5 2.1c0 4.6-6.5 8.4-6.5 8.4z',
  sub: 'M10 2.8l2.1 4.6 5 .5-3.8 3.4 1.1 4.9L10 13.7l-4.4 2.5 1.1-4.9L2.9 7.9l5-.5z',
  resub: 'M10 2.8l2.1 4.6 5 .5-3.8 3.4 1.1 4.9L10 13.7l-4.4 2.5 1.1-4.9L2.9 7.9l5-.5z',
  gift: 'M3.5 8h13v3h-13zM4.5 11h11v6h-11zM10 8v9M10 8C8 4 5 5 6.5 7.5M10 8c2-4 5-3 3.5-.5',
  bits: 'M10 2.5 16 8l-6 9.5L4 8z',
  raid: 'M3 16.5l5-5M8 11.5l2.5 2.5L17 4l-3 0-6.5 6.5L5 8l3.5 3.5',
};

type Phase = 'in' | 'hold' | 'out';

function useAlerts(el: El, live: boolean, playing: boolean): { alert: TwitchAlert | null; phase: Phase } {
  const p = el.props;
  const queue = useRef<TwitchAlert[]>([]);
  const [cur, setCur] = useState<{ alert: TwitchAlert; phase: Phase } | null>(live ? null : { alert: sampleAlert(0), phase: 'hold' });
  const props = useRef(p);
  props.current = p;
  const busy = useRef(false);

  const next = () => {
    const a = queue.current.shift();
    if (!a) {
      busy.current = false;
      setCur(live ? null : { alert: sampleAlert(0), phase: 'hold' });
      return;
    }
    busy.current = true;
    const q = props.current;
    playSound(q.sound, q.soundFile, num(q.volume, 0, 1, 0.6), live);
    setCur({ alert: a, phase: 'in' });
  };

  useHub(
    {
      twitchEvent: (raw: unknown) => {
        const a = readAlert(raw);
        if (!a || !wanted(a, props.current) || queue.current.length >= 20) return;
        queue.current.push(a);
        if (!busy.current) next();
      },
    },
    live,
  );

  // The Test buttons in the panel: shown here at once, whatever Preview is doing.
  useEffect(() => {
    if (live) return;
    const onTest = (e: Event) => {
      const kind = (e as CustomEvent<string>).detail as AlertKind;
      if (!ALERT_KINDS.includes(kind)) return;
      const n = ['follow', 'sub', 'bits', 'raid', 'resub', 'gift'].indexOf(kind);
      queue.current = [{ ...sampleAlert(n), id: 'test-' + Date.now() }];
      busy.current = false;
      next();
    };
    window.addEventListener('chaos-test-alert', onTest);
    return () => window.removeEventListener('chaos-test-alert', onTest);
  }, [live]);

  // in -> hold -> out -> the next one. One timer per step.
  useEffect(() => {
    if (!cur || (!live && !playing && !cur.alert.id.startsWith('test-'))) return;
    const hold = num(p.duration, 3, 15, 6) * 1000;
    const t =
      cur.phase === 'in'
        ? window.setTimeout(() => setCur({ ...cur, phase: 'hold' }), 450)
        : cur.phase === 'hold'
          ? window.setTimeout(() => setCur({ ...cur, phase: 'out' }), hold)
          : window.setTimeout(next, 500);
    return () => window.clearTimeout(t);
  }, [cur, live, playing, p.duration]);

  // Preview in the editor: the samples in turn, sounds included.
  useEffect(() => {
    if (live) return;
    queue.current = [];
    if (!playing) {
      busy.current = false;
      setCur({ alert: sampleAlert(0), phase: 'hold' });
      return;
    }
    let n = 0;
    const push = () => {
      queue.current.push(sampleAlert(n++));
      if (!busy.current) next();
    };
    push();
    const t = window.setInterval(push, (num(p.duration, 3, 15, 6) + 1.2) * 1000);
    return () => window.clearInterval(t);
  }, [live, playing]);

  return { alert: cur?.alert ?? null, phase: cur?.phase ?? 'out' };
}

function AlertStage({ el, live, playing }: StageProps) {
  const p = el.props;
  const { alert, phase } = useAlerts(el, !!live, playing);
  if (!alert) return null;
  const style = p.style === 'banner' || p.style === 'pop' ? p.style : 'card';
  const pic = imageUrl(p.file, !!live);
  const text = headline(alert, typeof p['t_' + alert.kind] === 'string' ? (p['t_' + alert.kind] as string) : undefined);
  const name = alert.name;
  const at = text.indexOf(name);
  return (
    <Region rect={fractionRect(el)} design={{ w: el.rect.w, h: el.rect.h }} opacity={num(p.opacity, 0.2, 1, 1)}>
      <div
        class={`al is-${style} ph-${phase}`}
        style={{ fontSize: num(p.textSize, 16, 64, 30) + 'px', ['--al-accent' as string]: accentOf(p) }}
        key={alert.id}
      >
        <div class="al-box">
          {pic ? (
            <img class="al-pic" src={pic} alt="" draggable={false} />
          ) : (
            <svg class="al-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d={KIND_ICON[alert.kind]} />
            </svg>
          )}
          <div class="al-words">
            <div class="al-head">
              {at >= 0 ? (
                <>
                  {text.slice(0, at)}
                  <b>{name}</b>
                  {text.slice(at + name.length)}
                </>
              ) : (
                text
              )}
            </div>
            {p.showMessage !== false && alert.message && <div class="al-msg">{alert.message}</div>}
          </div>
        </div>
      </div>
    </Region>
  );
}

const onFor = (key: string) => (p: Record<string, PropValue>) => p[key] !== false;

register({
  type: 'alerts',
  label: 'Alerts',
  blurb: 'Follows, subs, bits and raids, with a sound',
  icon: '',
  tone: 'menu-ic-alert',
  single: true,
  size: { w: 760, h: 200 },
  min: { w: 300, h: 90 },
  avoidByDefault: true,
  named: true,
  defaults: {
    follow: true,
    sub: true,
    bits: true,
    raid: true,
    minBits: 1,
    minRaid: 1,
    style: 'card',
    accent: '#9455FF',
    file: '',
    sound: 'chime',
    soundFile: '',
    volume: 0.6,
    duration: 6,
    showMessage: true,
    textSize: 30,
    opacity: 1,
  },
  fields: [
    {
      kind: 'followsAccess',
      key: 'follow',
      label: 'Follows need one more Twitch permission',
      hint: 'Twitch only tells ChaosBot about new followers once you allow it. Sign in again and approve "View your follower list".',
      when: onFor('follow'),
    },
    { kind: 'alertTest', key: 'test', label: 'Try it', hint: 'Shows here and in OBS. Tests never count toward goals.' },
    { kind: 'toggle', key: 'follow', label: 'Follows' },
    { kind: 'text', key: 't_follow', label: 'Follow message', max: 120, line: true, placeholder: '{name} just followed!', when: onFor('follow') },
    { kind: 'toggle', key: 'sub', label: 'Subs, resubs and gifts' },
    { kind: 'text', key: 't_sub', label: 'Sub message', max: 120, line: true, placeholder: '{name} just subscribed!', when: onFor('sub') },
    { kind: 'text', key: 't_resub', label: 'Resub message', max: 120, line: true, placeholder: '{name} subscribed for {amount} months!', when: onFor('sub') },
    { kind: 'text', key: 't_gift', label: 'Gift message', max: 120, line: true, placeholder: '{name} gifted {amount} subs!', when: onFor('sub') },
    { kind: 'toggle', key: 'bits', label: 'Bits' },
    { kind: 'text', key: 't_bits', label: 'Bits message', max: 120, line: true, placeholder: '{name} cheered {amount} bits!', when: onFor('bits') },
    { kind: 'slider', key: 'minBits', label: 'Smallest cheer, in bits', min: 1, max: 1000, step: 1, when: onFor('bits') },
    { kind: 'toggle', key: 'raid', label: 'Raids' },
    { kind: 'text', key: 't_raid', label: 'Raid message', max: 120, line: true, placeholder: '{name} is raiding with {amount} viewers!', when: onFor('raid') },
    { kind: 'slider', key: 'minRaid', label: 'Smallest raid, in viewers', min: 1, max: 100, step: 1, when: onFor('raid') },
    {
      kind: 'pick',
      key: 'style',
      label: 'Style',
      options: [
        { value: 'card', label: 'Card' },
        { value: 'banner', label: 'Banner' },
        { value: 'pop', label: 'Pop' },
      ],
    },
    { kind: 'swatches', key: 'accent', label: 'Accent', options: COLORS.filter((c) => c.value !== '#121116' && c.value !== '#FFFFFF') },
    { kind: 'image', key: 'file', label: 'Picture', hint: 'Optional. A GIF of you or your mascot shows next to the message.' },
    {
      kind: 'pick',
      key: 'sound',
      label: 'Sound',
      onPick: (v, p) => playSound(v, p.soundFile, num(p.volume, 0, 1, 0.6), false),
      options: [
        { value: 'none', label: 'None' },
        { value: 'chime', label: 'Chime' },
        { value: 'pop', label: 'Pop' },
        { value: 'coin', label: 'Coin' },
        { value: 'whoosh', label: 'Whoosh' },
        { value: 'custom', label: 'Your own' },
      ],
    },
    { kind: 'sound', key: 'soundFile', label: 'Your sound', hint: 'MP3, OGG or WAV, up to 8 MB.', when: (p) => p.sound === 'custom' },
    { kind: 'slider', key: 'volume', label: 'Volume', min: 0, max: 1, step: 0.05, percent: true, when: (p) => p.sound !== 'none' },
    { kind: 'slider', key: 'duration', label: 'Shows for', min: 3, max: 15, step: 1, unit: ' s' },
    { kind: 'toggle', key: 'showMessage', label: "The viewer's message", hint: 'What they typed with a cheer or a resub.' },
    { kind: 'slider', key: 'textSize', label: 'Text size', min: 16, max: 64, step: 1, unit: 'px' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.2, max: 1, step: 0.05, percent: true },
  ],
  feeds: ['events'],
  Stage: AlertStage,
});

/* ---------------------------------------------------------------- goal bar */

function GoalStage({ el, live, playing }: StageProps) {
  const p = el.props;
  const target = Math.round(num(p.target, 1, 1_000_000, 50));
  const [current, setCurrent] = useState(live ? 0 : Math.round(target * 0.62));
  useHub(
    {
      goal: (raw: unknown) => {
        const g = readGoal(raw);
        if (g && g.id === el.id) setCurrent(g.current);
      },
    },
    live,
  );
  // Preview: the bar fills in steps and starts again.
  useEffect(() => {
    if (live) return;
    if (!playing) {
      setCurrent(Math.round(target * 0.62));
      return;
    }
    let n = 0;
    const t = window.setInterval(() => setCurrent(Math.round((target * (++n % 11)) / 10)), 900);
    return () => window.clearInterval(t);
  }, [live, playing, target]);

  const f = fraction(current, target);
  const kind = p.kind === 'subs' || p.kind === 'bits' ? p.kind : 'follows';
  const unit = kind === 'follows' ? 'followers' : kind === 'subs' ? 'subs' : 'bits';
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  return (
    <Region rect={fractionRect(el)} design={{ w: el.rect.w, h: el.rect.h }} opacity={num(p.opacity, 0.2, 1, 1)}>
      <div
        class={'gl' + (p.style === 'slim' ? ' is-slim' : ' is-bar') + (f >= 1 ? ' is-full' : '')}
        style={{ fontSize: num(p.textSize, 14, 48, 22) + 'px', ['--gl-accent' as string]: accentOf(p) }}
      >
        <div class="gl-top">
          <span class="gl-title">{title || 'Goal'}</span>
          <span class="gl-count">
            {current.toLocaleString('en-US')} / {target.toLocaleString('en-US')} {unit}
          </span>
        </div>
        <div class="gl-track">
          <div class="gl-fill" style={{ width: (f * 100).toFixed(2) + '%' }} />
        </div>
      </div>
    </Region>
  );
}

register({
  type: 'goal',
  label: 'Goal bar',
  blurb: 'Followers, subs or bits toward a target',
  icon: '',
  tone: 'menu-ic-goal',
  size: { w: 640, h: 90 },
  min: { w: 200, h: 40 },
  avoidByDefault: true,
  named: true,
  defaults: { kind: 'follows', target: 50, title: 'Follower goal', style: 'bar', accent: '#9455FF', textSize: 22, opacity: 1 },
  fields: [
    {
      kind: 'pick',
      key: 'kind',
      label: 'Counts',
      hint: 'ChaosBot counts from when you add the bar, or from when you press Start over.',
      options: [
        { value: 'follows', label: 'Follows' },
        { value: 'subs', label: 'Subs' },
        { value: 'bits', label: 'Bits' },
      ],
    },
    { kind: 'slider', key: 'target', label: 'Target', min: 5, max: 5000, step: 5 },
    { kind: 'text', key: 'title', label: 'Title', max: 60, placeholder: 'Follower goal' },
    { kind: 'goalReset', key: 'startedAt', label: 'Count' },
    {
      kind: 'pick',
      key: 'style',
      label: 'Style',
      options: [
        { value: 'bar', label: 'Bar' },
        { value: 'slim', label: 'Slim' },
      ],
    },
    { kind: 'swatches', key: 'accent', label: 'Accent', options: COLORS.filter((c) => c.value !== '#121116' && c.value !== '#FFFFFF') },
    { kind: 'slider', key: 'textSize', label: 'Text size', min: 14, max: 48, step: 1, unit: 'px' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.2, max: 1, step: 0.05, percent: true },
  ],
  feeds: ['goals'],
  Stage: GoalStage,
});
