/* The command feed's data: what chat asked Chaos to do. ChaosBot sends `commandFeed` on the hub to
   scene pages that asked for the "commands" feed (CommandFeed in ChaosBot.Core). Everything here is
   checked, because it is drawn on stream. */

export type Outcome = 'done' | 'failed' | 'unsure' | 'skipped';

export interface FeedItem {
  id: string;
  user: string;
  text: string;
}
export interface FeedResult extends FeedItem {
  outcome: Outcome;
}
export interface Feed {
  now: FeedItem | null;
  next: FeedItem[];
  recent: FeedResult[];
}

export const EMPTY_FEED: Feed = { now: null, next: [], recent: [] };

const OUTCOMES: Outcome[] = ['done', 'failed', 'unsure', 'skipped'];
const MAX_TEXT = 100;
const MAX_USER = 25;

const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';

function item(v: unknown): FeedItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = clean(o.id, 64);
  const user = clean(o.user, MAX_USER);
  const text = clean(o.text, MAX_TEXT + 1);
  return id && user && text ? { id, user, text } : null;
}

function list<T>(v: unknown, read: (x: unknown) => T | null, max: number): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    const r = read(x);
    if (r) out.push(r);
    if (out.length === max) break;
  }
  return out;
}

/** The hub's `commandFeed` body, or the empty feed when it is not one. */
export function readFeed(raw: unknown): Feed {
  if (!raw || typeof raw !== 'object') return EMPTY_FEED;
  const o = raw as Record<string, unknown>;
  return {
    now: item(o.now),
    next: list(o.next, item, 5),
    recent: list(
      o.recent,
      (x) => {
        const i = item(x);
        const outcome = (x as Record<string, unknown>).outcome as Outcome;
        return i && OUTCOMES.includes(outcome) ? { ...i, outcome } : null;
      },
      8,
    ),
  };
}

/** The feed as an element shows it: so many queued rows and so many results. */
export function visible(feed: Feed, next: number, recent: number): Feed {
  return { now: feed.now, next: feed.next.slice(0, Math.max(0, next)), recent: feed.recent.slice(0, Math.max(0, recent)) };
}

export const isEmpty = (f: Feed) => !f.now && f.next.length === 0 && f.recent.length === 0;

/* The editor's sample: a few steps of a stream, so Preview shows rows arriving and leaving. */

const ASKS: [string, string][] = [
  ['pixelpanda', 'crouch walk to the next objective'],
  ['moonbyte', 'throw a grenade at the window'],
  ['sir_toasty', 'spin around three times'],
  ['NovaKade', 'reload and jump off the ledge'],
  ['glitchfox', 'switch to the pistol'],
  ['Lumen_ttv', 'emote at the enemy'],
  ['bitbybit', 'look up at the sky for five seconds'],
  ['RoboRaccoon', 'sprint to the car'],
];
const RESULTS: Outcome[] = ['done', 'done', 'unsure', 'done', 'failed', 'done', 'skipped'];

/** Step `n` of the sample stream. Step 0 is the still picture the editor shows without Preview. */
export function sampleFeed(n: number): Feed {
  const at = (i: number) => {
    const k = ((i % ASKS.length) + ASKS.length) % ASKS.length;
    return { id: 's' + i, user: ASKS[k][0], text: ASKS[k][1] };
  };
  const s = n + 2;
  return {
    now: at(s),
    next: [at(s + 1), at(s + 2), at(s + 3)],
    recent: [s - 1, s - 2, s - 3].map((i) => ({ ...at(i), outcome: RESULTS[((i % RESULTS.length) + RESULTS.length) % RESULTS.length] })),
  };
}
