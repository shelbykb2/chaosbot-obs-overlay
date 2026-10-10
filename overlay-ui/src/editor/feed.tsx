import { useEffect, useState } from 'preact/hooks';
import { EMPTY_FEED, isEmpty, readFeed, sampleFeed, visible, type Feed, type Outcome } from '../shared/commandFeed';
import { useHub } from '../shared/hub';
import { Region } from '../shared/Region';
import '../shared/feed.css';
import { COLORS } from './basics';
import { CANVAS, type PropValue } from './model';
import { register, type StageProps } from './registry';

/* The command feed: what chat asked Chaos to do. The one running now, what is queued next, and how
   the last few went. In OBS it follows the hub's commandFeed; in the editor it shows a sample, and
   Preview plays it forward so the streamer sees rows arrive. Idle costs nothing: rows slide in once
   with a CSS animation and the only loop is the "running" dots while something runs. */

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v: PropValue | undefined, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};
const str = (v: PropValue | undefined, d: string) => (typeof v === 'string' ? v : d);

const OUTCOME_LABEL: Record<Outcome, string> = {
  done: 'Done',
  failed: "Didn't work",
  unsure: 'Not sure it worked',
  skipped: 'Skipped',
};

function OutcomeIcon({ outcome }: { outcome: Outcome }) {
  const path =
    outcome === 'done'
      ? 'M4 10.5l4 4 8-9'
      : outcome === 'failed'
        ? 'M5 5l10 10M15 5L5 15'
        : outcome === 'unsure'
          ? 'M7.2 7.4a2.9 2.9 0 1 1 3.9 2.7c-.7.3-1.1.9-1.1 1.6v.6M10 15.2v.1'
          : 'M4 13a6 6 0 0 1 11-3.3M15 5v4.7h-4.7';
  return (
    <svg class={'cf-ic is-' + outcome} viewBox="0 0 20 20" aria-label={OUTCOME_LABEL[outcome]}>
      <path d={path} />
    </svg>
  );
}

function useFeed(live: boolean, playing: boolean): Feed {
  const [feed, setFeed] = useState<Feed>(live ? EMPTY_FEED : sampleFeed(0));
  useHub({ commandFeed: (raw: unknown) => setFeed(readFeed(raw)) }, live);
  // Preview: one step of the sample every 2.4 s, only while playing.
  useEffect(() => {
    if (live) return;
    if (!playing) {
      setFeed(sampleFeed(0));
      return;
    }
    let n = 0;
    const t = window.setInterval(() => setFeed(sampleFeed(++n)), 2400);
    return () => window.clearInterval(t);
  }, [live, playing]);
  return feed;
}

function FeedStage({ el, live, playing }: StageProps) {
  const p = el.props;
  const all = useFeed(!!live, playing);
  const feed = visible(all, num(p.next, 0, 5, 3), num(p.recent, 0, 5, 3));
  const empty = isEmpty(feed);
  if (empty && live && p.whenEmpty === 'hide') return null;

  const accent = typeof p.accent === 'string' && HEX.test(p.accent) ? p.accent : '#9455FF';
  const title = str(p.title, 'Chat runs Chaos').trim();
  const hint = str(p.hint, 'Tell Chaos what to do in chat').trim();
  const queued = all.next.length;

  return (
    <Region
      rect={{ x: el.rect.x / CANVAS.w, y: el.rect.y / CANVAS.h, w: el.rect.w / CANVAS.w, h: el.rect.h / CANVAS.h }}
      design={{ w: el.rect.w, h: el.rect.h }}
      opacity={Math.min(1, Math.max(0.2, Number(p.opacity) || 1))}
    >
      <div
        class={'cf' + (p.panel === 'clear' ? ' is-clear' : ' is-panel')}
        style={{ fontSize: num(p.textSize, 14, 40, 20) + 'px', ['--cf-accent' as string]: accent }}
      >
        {title && (
          <div class="cf-head">
            <span class="cf-title">{title}</span>
            {queued > 0 && <span class="cf-count">{queued} waiting</span>}
          </div>
        )}

        {empty && <div class="cf-hint">{hint}</div>}

        {feed.now && (
          <div class="cf-now" key={'now-' + feed.now.id}>
            <div class="cf-now-top">
              <span class="cf-tag">Now</span>
              <span class="cf-user">{feed.now.user}</span>
              <span class="cf-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </div>
            <div class="cf-text">{feed.now.text}</div>
          </div>
        )}

        {feed.next.length > 0 && (
          <div class="cf-group">
            <div class="cf-label">Up next</div>
            {feed.next.map((it, i) => (
              <div class="cf-row" key={'n-' + it.id}>
                <span class="cf-num">{i + 1}</span>
                <span class="cf-user">{it.user}</span>
                <span class="cf-text">{it.text}</span>
              </div>
            ))}
          </div>
        )}

        {feed.recent.length > 0 && (
          <div class="cf-group is-recent">
            {feed.recent.map((it) => (
              <div class={'cf-row is-' + it.outcome} key={'r-' + it.id}>
                <OutcomeIcon outcome={it.outcome} />
                <span class="cf-user">{it.user}</span>
                <span class="cf-text">{it.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Region>
  );
}

register({
  type: 'commandFeed',
  label: 'Command feed',
  blurb: 'What chat asked Chaos to do, and how it went',
  icon: '',
  tone: 'menu-ic-feed',
  single: true,
  size: { w: 520, h: 380 },
  min: { w: 260, h: 120 },
  avoidByDefault: true,
  named: true,
  defaults: {
    title: 'Chat runs Chaos',
    next: 3,
    recent: 3,
    whenEmpty: 'hint',
    hint: 'Tell Chaos what to do in chat',
    accent: '#9455FF',
    panel: 'panel',
    textSize: 20,
    opacity: 1,
  },
  fields: [
    { kind: 'text', key: 'title', label: 'Title', max: 40, placeholder: 'No title', hint: 'Leave it empty for no title.' },
    { kind: 'slider', key: 'next', label: 'Up next rows', min: 0, max: 5, step: 1 },
    { kind: 'slider', key: 'recent', label: 'Results rows', min: 0, max: 5, step: 1, hint: 'A tick when it worked, a cross when it did not, a question mark when ChaosBot could not tell.' },
    {
      kind: 'pick',
      key: 'whenEmpty',
      label: 'When nothing is happening',
      options: [
        { value: 'hint', label: 'Show a hint' },
        { value: 'hide', label: 'Hide it' },
      ],
    },
    { kind: 'text', key: 'hint', label: 'Hint', max: 80, placeholder: 'Tell Chaos what to do in chat', when: (p) => p.whenEmpty !== 'hide' },
    { kind: 'swatches', key: 'accent', label: 'Accent', options: COLORS.filter((c) => c.value !== '#121116' && c.value !== '#FFFFFF') },
    {
      kind: 'pick',
      key: 'panel',
      label: 'Background',
      options: [
        { value: 'panel', label: 'Dark panel' },
        { value: 'clear', label: 'None' },
      ],
    },
    { kind: 'slider', key: 'textSize', label: 'Text size', min: 14, max: 40, step: 1, unit: 'px' },
    { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.2, max: 1, step: 0.05, percent: true },
  ],
  feeds: ['commands'],
  Stage: FeedStage,
});
