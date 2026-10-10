/* The chat box's data: Twitch chat lines from the hub (`chatHistory`, `chat`, `chatClear`, sent to
   scene pages that asked for the "chat" feed). Chat is drawn on stream, so everything is checked
   here and rendered as text nodes and emote pictures only, never as HTML. */

export type Badge = 'broadcaster' | 'moderator' | 'vip' | 'subscriber' | 'partner';
export const BADGES: Badge[] = ['broadcaster', 'moderator', 'vip', 'subscriber', 'partner'];

export interface Emote {
  id: string;
  start: number;
  end: number;
}
export interface ChatLine {
  id: string;
  user: string;
  name: string;
  color: string;
  badges: Badge[];
  text: string;
  emotes: Emote[];
  action: boolean;
}

export const MAX_LINES = 30;
const EMOTE_ID = /^[A-Za-z0-9_]{1,64}$/;
const HEX = /^#[0-9a-f]{6}$/i;

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max) : '');

/** One `chat` line, or null when it is not one. */
export function readLine(raw: unknown): ChatLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = clean(o.id, 64);
  const user = clean(o.user, 25).toLowerCase();
  const text = clean(o.text, 500);
  if (!id || !user || !text.trim()) return null;
  const name = clean(o.name, 25).trim() || user;
  const color = typeof o.color === 'string' && HEX.test(o.color) ? o.color : '';
  const badges = Array.isArray(o.badges) ? BADGES.filter((b) => (o.badges as unknown[]).includes(b)) : [];
  const emotes: Emote[] = [];
  if (Array.isArray(o.emotes)) {
    for (const e of o.emotes) {
      if (!e || typeof e !== 'object') continue;
      const { id: eid, start, end } = e as Record<string, unknown>;
      if (typeof eid !== 'string' || !EMOTE_ID.test(eid)) continue;
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      const s = start as number;
      const t = end as number;
      if (s < 0 || t < s || t >= text.length) continue;
      emotes.push({ id: eid, start: s, end: t });
    }
    emotes.sort((a, b) => a.start - b.start);
  }
  // Overlapping ranges are dropped: the first one wins.
  const kept: Emote[] = [];
  for (const e of emotes) if (!kept.length || e.start > kept[kept.length - 1].end) kept.push(e);
  return { id, user, name, color, badges, text, emotes: kept, action: o.action === true || o.isAction === true };
}

export function readHistory(raw: unknown): ChatLine[] {
  const lines = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).lines : null;
  if (!Array.isArray(lines)) return [];
  const out: ChatLine[] = [];
  for (const l of lines) {
    const r = readLine(l);
    if (r) out.push(r);
  }
  return out.slice(-MAX_LINES);
}

/** Adds a line at the bottom, keeping the newest MAX_LINES. A repeated id is ignored. */
export function addLine(lines: ChatLine[], line: ChatLine): ChatLine[] {
  if (lines.some((l) => l.id === line.id)) return lines;
  const next = lines.concat(line);
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

/** A deleted message, a banned or timed-out viewer, or the whole chat cleared. */
export function applyClear(lines: ChatLine[], raw: unknown): ChatLine[] {
  if (!raw || typeof raw !== 'object') return lines;
  const o = raw as Record<string, unknown>;
  if (o.all === true) return [];
  if (typeof o.id === 'string' && o.id) return lines.filter((l) => l.id !== o.id);
  if (typeof o.user === 'string' && o.user) {
    const u = o.user.toLowerCase();
    return lines.filter((l) => l.user !== u);
  }
  return lines;
}

export type Segment = { text: string } | { emote: string; alt: string };

/** The line cut into text and emotes. Indices are UTF-16, as ChaosBot sends them. */
export function segments(line: ChatLine): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const e of line.emotes) {
    if (e.start > at) out.push({ text: line.text.slice(at, e.start) });
    out.push({ emote: e.id, alt: line.text.slice(e.start, e.end + 1) });
    at = e.end + 1;
  }
  if (at < line.text.length) out.push({ text: line.text.slice(at) });
  return out;
}

export const emoteUrl = (id: string) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;

/* Twitch's own colours for viewers who never picked one, chosen by name so a viewer keeps theirs. */
const DEFAULTS = ['#FF4D4D', '#4A8CFF', '#3CC85A', '#B85CFF', '#FF7F50', '#9ACD32', '#FF6FAE', '#2EC4B6', '#DAA520', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00C878'];

/** The name colour, lifted until it reads on a dark background. */
export function nameColor(line: Pick<ChatLine, 'color' | 'user'>): string {
  let c = line.color;
  if (!c) {
    let h = 0;
    for (const ch of line.user) h = (h * 31 + ch.charCodeAt(0)) | 0;
    c = DEFAULTS[Math.abs(h) % DEFAULTS.length];
  }
  let r = parseInt(c.slice(1, 3), 16);
  let g = parseInt(c.slice(3, 5), 16);
  let b = parseInt(c.slice(5, 7), 16);
  // Relative luminance; mix toward white until it is at least 0.25.
  const lum = () => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  for (let i = 0; i < 8 && lum() < 0.25; i++) {
    r = Math.round(r + (255 - r) * 0.25);
    g = Math.round(g + (255 - g) * 0.25);
    b = Math.round(b + (255 - b) * 0.25);
  }
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

/** Logins from the "Hide these viewers" field: commas or spaces between them. */
export function hiddenUsers(v: unknown): Set<string> {
  if (typeof v !== 'string') return new Set();
  return new Set(
    v
      .toLowerCase()
      .split(/[\s,]+/)
      .map((s) => s.replace(/^@/, ''))
      .filter(Boolean),
  );
}

/** What the box shows: commands and listed viewers left out when asked. */
export function shown(lines: ChatLine[], opts: { hideCommands: boolean; hide: Set<string> }): ChatLine[] {
  return lines.filter((l) => !(opts.hideCommands && l.text.trimStart().startsWith('!')) && !opts.hide.has(l.user));
}

/* The editor's sample chat. */

const SAMPLE: Omit<ChatLine, 'id'>[] = [
  { user: 'pixelpanda', name: 'pixelpanda', color: '#FF7F50', badges: ['subscriber'], text: 'that was so clean', emotes: [], action: false },
  { user: 'moonbyte', name: 'moonbyte', color: '#4A8CFF', badges: ['vip'], text: 'chaos make him jump PogChamp', emotes: [{ id: '305954156', start: 20, end: 27 }], action: false },
  { user: 'nightbot', name: 'Nightbot', color: '#7C7CE1', badges: ['moderator'], text: 'Follow on socials: @chaosbot', emotes: [], action: false },
  { user: 'sir_toasty', name: 'sir_toasty', color: '', badges: [], text: '!chaos spin around three times', emotes: [], action: false },
  { user: 'novakade', name: 'NovaKade', color: '#B85CFF', badges: ['moderator', 'subscriber'], text: 'gg everyone', emotes: [], action: false },
  { user: 'glitchfox', name: 'glitchfox', color: '#3CC85A', badges: [], text: 'waves at chat', emotes: [], action: true },
  { user: 'lumen_ttv', name: 'Lumen_ttv', color: '#000080', badges: ['subscriber'], text: 'how long have you been playing this?', emotes: [], action: false },
  { user: 'streamer', name: 'You', color: '#9455FF', badges: ['broadcaster'], text: 'thanks for hanging out everyone', emotes: [], action: false },
];

/** Sample line `n` (any integer), with a unique id. */
export function sampleLine(n: number): ChatLine {
  const k = ((n % SAMPLE.length) + SAMPLE.length) % SAMPLE.length;
  return { ...SAMPLE[k], id: 'sample-' + n };
}

export const sampleChat = (upTo: number, count = 8): ChatLine[] =>
  Array.from({ length: count }, (_, i) => sampleLine(upTo - count + 1 + i));
