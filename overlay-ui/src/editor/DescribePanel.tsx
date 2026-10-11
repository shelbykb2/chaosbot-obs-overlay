import { useEffect, useRef, useState } from 'preact/hooks';
import { MAX_DESCRIPTION } from './describe';
import { closeDescribe, describeLayout, keepDraft, openDescribe, throwAwayDraft } from './describing';
import { useStore } from './store';

/* Describe a layout: the streamer says what they want in their own words, the model drafts it,
   and the draft opens as a layout that is not live. The draft bar takes the layout bar's place
   until the streamer keeps it or throws it away. */

const STARTERS = [
  'Cozy and purple. Chat down the left, the Spotify card in the top right.',
  'Clean and minimal. Only the Spotify card, small, in a corner.',
  'Bright and loud. A command feed, chat, and alerts for follows and subs.',
];

export function DescribePanel() {
  const st = useStore();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [words, setWords] = useState('');
  const [picture, setPicture] = useState(true);
  const change = st.describe.change;
  useEffect(() => {
    ref.current?.focus();
  }, [change]);
  const canSend = !!words.trim() && !st.describing;
  const go = () => canSend && describeLayout(words, picture);
  return (
    <section class="card ds" aria-label={change ? 'Ask for a change' : 'Describe a layout'}>
      <div class="ds-head">
        <i class="ic ds-mark">{''}</i>
        <div>
          <div class="card-title">{change ? 'Ask for a change' : 'Describe a layout'}</div>
          <div class="caption">
            {change
              ? 'Say what to change. Everything else stays as it is.'
              : 'Say what you want in your own words. It opens as a new layout that is not live, so nothing changes on stream until you say so.'}
          </div>
        </div>
        <button class="icon-btn" title="Close" aria-label="Close" onClick={closeDescribe}>
          <i class="ic">{''}</i>
        </button>
      </div>
      <textarea
        ref={ref}
        class="ds-text"
        rows={3}
        maxLength={MAX_DESCRIPTION}
        value={words}
        disabled={st.describing}
        placeholder={change ? 'Make the chat smaller and move it to the right.' : 'Chat down the left in purple, the Spotify card top right, and a follower goal along the bottom.'}
        onInput={(e) => setWords((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go();
          else if (e.key === 'Escape') closeDescribe();
          e.stopPropagation();
        }}
      />
      {!change && !words && (
        <div class="ds-starters" aria-label="Ideas to start from">
          {STARTERS.map((s) => (
            <button key={s} class="pk-chip" onClick={() => setWords(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {st.describe.error && (
        <div class="ds-error" role="alert">
          <i class="ic">{''}</i>
          {st.describe.error}
        </div>
      )}
      <div class="ds-foot">
        <label class={'ds-pic' + (st.still ? '' : ' is-off')} title={st.still ? 'Lets it see your game so it keeps widgets off the HUD' : 'Open a game, or turn on Live from OBS, to use this'}>
          <button
            class="switch"
            role="switch"
            aria-checked={picture && !!st.still}
            aria-label="Look at the game picture"
            disabled={!st.still || st.describing}
            onClick={() => setPicture(!picture)}
          />
          Look at the game picture
        </label>
        <span class="spacer" />
        <span class="ds-count">
          {words.length} / {MAX_DESCRIPTION}
        </span>
        <button class="btn" onClick={closeDescribe}>
          Cancel
        </button>
        <button class="btn btn-accent" disabled={!canSend} onClick={go} aria-busy={st.describing}>
          {st.describing ? (
            <>
              <span class="ds-busy" aria-hidden="true" />
              Drafting
            </>
          ) : (
            <>
              <i class="ic">{''}</i>
              {change ? 'Change it' : 'Draft it'}
            </>
          )}
        </button>
      </div>
    </section>
  );
}

export function DraftBar() {
  const st = useStore();
  const d = st.draft;
  if (!d) return null;
  return (
    <div class="ly-bar ds-bar" role="region" aria-label="Draft layout">
      <span class="ds-tag">Draft</span>
      <span class="ds-says">
        Not on stream. Move things around, ask for a change, or keep it.
        {d.dropped.length > 0 && <span class="ds-left"> Left out: {d.dropped.join(', ')}.</span>}
      </span>
      <span class="spacer" />
      <button class="btn" onClick={() => openDescribe(true)} disabled={st.describing}>
        <i class="ic">{''}</i>Ask for a change
      </button>
      <button class="btn" onClick={throwAwayDraft}>
        <i class="ic">{''}</i>Throw away
      </button>
      <button class="btn btn-accent" onClick={keepDraft}>
        <i class="ic">{''}</i>Keep it
      </button>
    </div>
  );
}
