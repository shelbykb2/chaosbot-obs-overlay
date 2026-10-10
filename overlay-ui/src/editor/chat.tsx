import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  addLine,
  applyClear,
  emoteUrl,
  hiddenUsers,
  nameColor,
  readHistory,
  readLine,
  sampleChat,
  sampleLine,
  segments,
  shown,
  type Badge,
  type ChatLine,
} from '../shared/chat';
import { useHub } from '../shared/hub';
import { Region } from '../shared/Region';
import '../shared/chat.css';
import { CANVAS, type PropValue } from './model';
import { register, type StageProps } from './registry';

/* The chat box: live Twitch chat. In OBS it follows the hub's chat feed and drops deleted
   messages, banned or timed-out viewers and cleared chats the moment Twitch says so. In the editor
   it shows a sample, and Preview adds lines. Idle costs nothing: a line slides in once, and
   fading old lines uses one timer for the next one due, never an animation frame. */

const num = (v: PropValue | undefined, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

const BADGE_PATH: Record<Badge, string> = {
  broadcaster: 'M3 6.5h7.5v7H3zM10.5 8.5 15 6v8l-4.5-2.5',
  moderator: 'M10 2.5 16 5v4.5c0 3.6-2.5 6.4-6 8-3.5-1.6-6-4.4-6-8V5z',
  vip: 'M10 3 16.5 8 10 17 3.5 8zM3.5 8h13',
  subscriber: 'M10 2.8l2.1 4.6 5 .5-3.8 3.4 1.1 4.9L10 13.7l-4.4 2.5 1.1-4.9L2.9 7.9l5-.5z',
  partner: 'M4.5 10.5l3.5 3.5 7.5-8',
};
const BADGE_NAME: Record<Badge, string> = {
  broadcaster: 'Streamer',
  moderator: 'Moderator',
  vip: 'VIP',
  subscriber: 'Subscriber',
  partner: 'Verified',
};

function Badges({ badges }: { badges: Badge[] }) {
  if (!badges.length) return null;
  return (
    <span class="ch-badges">
      {badges.map((b) => (
        <svg key={b} class={'ch-badge is-' + b} viewBox="0 0 20 20" aria-label={BADGE_NAME[b]}>
          <path d={BADGE_PATH[b]} />
        </svg>
      ))}
    </span>
  );
}

function Line({ line, badges }: { line: ChatLine; badges: boolean }) {
  const color = nameColor(line);
  return (
    <div class={'ch-line' + (line.action ? ' is-action' : '')}>
      {badges && <Badges badges={line.badges} />}
      <span class="ch-name" style={{ color }}>
        {line.name}
      </span>
      {!line.action && <span class="ch-colon">:</span>}
      <span class="ch-text" style={line.action ? { color } : undefined}>
        {segments(line).map((s, i) =>
          'emote' in s ? <img key={i} class="ch-emote" src={emoteUrl(s.emote)} alt={s.alt} draggable={false} /> : <span key={i}>{s.text}</span>,
        )}
      </span>
    </div>
  );
}

function useChat(live: boolean, playing: boolean): ChatLine[] {
  const [lines, setLines] = useState<ChatLine[]>(live ? [] : sampleChat(7));
  useHub(
    {
      chatHistory: (raw: unknown) => setLines(readHistory(raw)),
      chat: (raw: unknown) => {
        const line = readLine(raw && typeof raw === 'object' ? (raw as { line?: unknown }).line : null);
        if (line) setLines((ls) => addLine(ls, line));
      },
      chatClear: (raw: unknown) => setLines((ls) => applyClear(ls, raw)),
    },
    live,
  );
  // Preview: a new sample line every 1.6 s, only while playing.
  useEffect(() => {
    if (live) return;
    if (!playing) {
      setLines(sampleChat(7));
      return;
    }
    let n = 7;
    const t = window.setInterval(() => {
      n++;
      setLines((ls) => addLine(ls, sampleLine(n)));
    }, 1600);
    return () => window.clearInterval(t);
  }, [live, playing]);
  return lines;
}

/** Lines older than `seconds` are left out. One timer, set for the next line to go. */
function useFade(lines: ChatLine[], seconds: number): ChatLine[] {
  const [born] = useState(() => new Map<string, number>());
  const [, tick] = useState(0);
  const now = Date.now();
  for (const l of lines) if (!born.has(l.id)) born.set(l.id, now);
  for (const id of born.keys()) if (!lines.some((l) => l.id === id)) born.delete(id);
  const keep = seconds > 0 ? lines.filter((l) => now - (born.get(l.id) ?? now) < seconds * 1000) : lines;
  const nextDue = seconds > 0 && keep.length ? Math.min(...keep.map((l) => (born.get(l.id) ?? now) + seconds * 1000)) : 0;
  useEffect(() => {
    if (!nextDue) return;
    const t = window.setTimeout(() => tick((x) => x + 1), Math.max(50, nextDue - Date.now()));
    return () => window.clearTimeout(t);
  }, [nextDue]);
  return keep;
}

function ChatStage({ el, live, playing }: StageProps) {
  const p = el.props;
  const all = useChat(!!live, playing);
  const hide = useMemo(() => hiddenUsers(p.hideUsers), [p.hideUsers]);
  const filtered = shown(all, { hideCommands: p.hideCommands !== false, hide });
  const visible = useFade(filtered, live ? num(p.fade, 0, 600, 0) : 0).slice(-num(p.lines, 3, 30, 12));
  const style = p.style === 'bubbles' ? 'bubbles' : 'lines';
  const bg = p.background === 'soft' || p.background === 'solid' ? p.background : 'none';

  if (!visible.length && live) return null;
  return (
    <Region
      rect={{ x: el.rect.x / CANVAS.w, y: el.rect.y / CANVAS.h, w: el.rect.w / CANVAS.w, h: el.rect.h / CANVAS.h }}
      design={{ w: el.rect.w, h: el.rect.h }}
      opacity={Math.min(1, Math.max(0.2, Number(p.opacity) || 1))}
    >
      <div class={`ch is-${style} bg-${bg}`} style={{ fontSize: num(p.textSize, 14, 40, 20) + 'px' }}>
        <div class="ch-list">
          {visible.length ? (
            visible.map((l) => <Line key={l.id} line={l} badges={p.badges !== false} />)
          ) : (
            <div class="ch-empty">Chat shows here</div>
          )}
        </div>
      </div>
    </Region>
  );
}

register({
  type: 'chat',
  label: 'Chat',
  blurb: 'Your Twitch chat, with emotes. Deleted messages disappear',
  icon: '',
  tone: 'menu-ic-chat',
  single: true,
  size: { w: 480, h: 520 },
  min: { w: 220, h: 120 },
  avoidByDefault: true,
  named: true,
  defaults: {
    style: 'lines',
    background: 'soft',
    badges: true,
    hideCommands: true,
    hideUsers: 'nightbot, streamelements, streamlabs, moobot, fossabot',
    lines: 12,
    fade: '0',
    textSize: 20,
    opacity: 1,
  },
  fields: [
    {
      kind: 'pick',
      key: 'style',
      label: 'Style',
      options: [
        { value: 'lines', label: 'Lines' },
        { value: 'bubbles', label: 'Bubbles' },
      ],
    },
    {
      kind: 'pick',
      key: 'background',
      label: 'Background',
      options: [
        { value: 'none', label: 'None' },
        { value: 'soft', label: 'Soft' },
        { value: 'solid', label: 'Solid' },
      ],
    },
    { kind: 'toggle', key: 'badges', label: 'Badges', hint: 'Streamer, moderator, VIP and subscriber.' },
    { kind: 'toggle', key: 'hideCommands', label: 'Hide !commands', hint: "Lines that start with ! stay in Twitch chat but not on stream. Chaos's command feed shows those." },
    { kind: 'text', key: 'hideUsers', label: 'Hide these viewers', max: 300, placeholder: 'nightbot, streamelements', hint: 'Usually your chat bots. Commas between names.' },
    { kind: 'slider', key: 'lines', label: 'Most lines shown', min: 3, max: 30, step: 1 },
    {
      kind: 'pick',
      key: 'fade',
      label: 'Old messages',
      options: [
        { value: '0', label: 'Stay' },
        { value: '30', label: 'Go after 30 s' },
        { value: '60', label: 'After 1 min' },
        { value: '180', label: 'After 3 min' },
      ],
    },
    { kind: 'slider', key: 'textSize', label: 'Text size', min: 14, max: 40, step: 1, unit: 'px' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.2, max: 1, step: 0.05, percent: true },
  ],
  feeds: ['chat'],
  Stage: ChatStage,
});
