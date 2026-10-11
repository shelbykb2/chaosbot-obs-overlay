/* Alerts and goals: Twitch events from the hub (`twitchEvent` and `goal`, sent to scene pages that
   asked for the "events" or "goals" feed). Drawn on stream, so everything is checked here. */

export type AlertKind = 'follow' | 'sub' | 'resub' | 'gift' | 'bits' | 'raid';
export const ALERT_KINDS: AlertKind[] = ['follow', 'sub', 'resub', 'gift', 'bits', 'raid'];

export interface TwitchAlert {
  id: string;
  kind: AlertKind;
  name: string;
  /** Bits, gifted subs or raiders; months for a resub. */
  amount: number;
  /** The viewer's own message (a cheer or resub message), when there is one. */
  message: string;
  test: boolean;
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');

let seq = 0;

export function readAlert(raw: unknown): TwitchAlert | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind as AlertKind;
  if (!ALERT_KINDS.includes(kind)) return null;
  const name = clean(o.name, 25);
  if (!name) return null;
  const n = Number(o.amount);
  return {
    id: clean(o.id, 64) || 'a' + ++seq,
    kind,
    name,
    amount: Number.isFinite(n) && n > 0 ? Math.min(1_000_000, Math.floor(n)) : 0,
    message: clean(o.message, 200),
    test: o.test === true,
  };
}

/** Which alert setting covers an event: a resub and a gift use the sub settings unless split. */
export const settingFor = (kind: AlertKind): 'follow' | 'sub' | 'bits' | 'raid' =>
  kind === 'resub' || kind === 'gift' ? 'sub' : kind;

export const DEFAULT_TEMPLATES: Record<AlertKind, string> = {
  follow: '{name} just followed!',
  sub: '{name} just subscribed!',
  resub: '{name} subscribed for {amount} months!',
  gift: '{name} gifted {amount} subs!',
  bits: '{name} cheered {amount} bits!',
  raid: '{name} is raiding with {amount} viewers!',
};

/** The headline for an alert: the streamer's template with {name} and {amount} filled in. */
export function headline(a: TwitchAlert, template: string | undefined): string {
  const t = (template ?? '').trim() || DEFAULT_TEMPLATES[a.kind];
  return t.replace(/\{(name|amount)\}/g, (_, k: string) => (k === 'name' ? a.name : a.amount.toLocaleString('en-US'))).slice(0, 160);
}

/** Does this alert pass the element's switches and minimums? */
export function wanted(a: TwitchAlert, p: Record<string, unknown>): boolean {
  const s = settingFor(a.kind);
  if (p[s] === false) return false;
  if (a.kind === 'bits' && a.amount < (Number(p.minBits) || 1)) return false;
  if (a.kind === 'raid' && a.amount < (Number(p.minRaid) || 1)) return false;
  return true;
}

/* Goals. */

export type GoalKind = 'follows' | 'subs' | 'bits';
export const GOAL_KINDS: GoalKind[] = ['follows', 'subs', 'bits'];

export interface GoalState {
  id: string;
  current: number;
}

/** The hub's `goal` body: one element's count. */
export function readGoal(raw: unknown): GoalState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = clean(o.id, 64);
  const n = Number(o.current);
  return id && Number.isFinite(n) && n >= 0 ? { id, current: Math.floor(n) } : null;
}

export const fraction = (current: number, target: number) => (target > 0 ? Math.max(0, Math.min(1, current / target)) : 0);

/* The editor's samples. */

const SAMPLES: Omit<TwitchAlert, 'id'>[] = [
  { kind: 'follow', name: 'pixelpanda', amount: 0, message: '', test: true },
  { kind: 'sub', name: 'moonbyte', amount: 0, message: '', test: true },
  { kind: 'bits', name: 'NovaKade', amount: 500, message: 'make chaos do a backflip', test: true },
  { kind: 'raid', name: 'glitchfox', amount: 42, message: '', test: true },
  { kind: 'resub', name: 'Lumen_ttv', amount: 14, message: 'still here!', test: true },
  { kind: 'gift', name: 'sir_toasty', amount: 5, message: '', test: true },
];

export function sampleAlert(n: number): TwitchAlert {
  const k = ((n % SAMPLES.length) + SAMPLES.length) % SAMPLES.length;
  return { ...SAMPLES[k], id: 'sample-' + n };
}
