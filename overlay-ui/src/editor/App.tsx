import { copyUrl, openSettings, setMirror, testHello } from './actions';
import { Canvas } from './Canvas';
import { DescribePanel, DraftBar } from './DescribePanel';
import { Elements } from './ElementList';
import { LayoutBar, LayoutStrip } from './Layouts';
import { Props } from './Props';
import { canRedo, canUndo, redo, scene, selected, set, undo, useStore, type Urls } from './store';
import chaosHead from './chaos-head.png';
import { Connections } from './Connections';

/* The Overlay page inside ChaosBot. The app's own nav and title bar sit around it. */

function Saved() {
  const st = useStore();
  if (st.saved === 'error')
    return (
      <span class="saved is-error" role="status">
        <i class="ic">{''}</i>
        <span>Not saved</span>
      </span>
    );
  return (
    <span class="saved" role="status">
      <i class="ic">{st.saved === 'saving' ? '' : ''}</i>
      <span>{st.saved === 'saving' ? 'Saving' : 'All changes saved'}</span>
    </span>
  );
}

function Toolbar() {
  const st = useStore();
  return (
    <div class="toolbar" role="toolbar" aria-label="Canvas tools">
      <div class="seg">
        <button aria-pressed={st.tool === 'select'} title="Select (V)" onClick={() => set({ tool: 'select' })}>
          <i class="ic">{''}</i>Select
        </button>
      </div>
      <button class="tgl" aria-pressed={st.snap} title="Snap to edges, centre lines and other elements. Hold Alt to drag freely." onClick={() => set({ snap: !st.snap })}>
        <i class="ic">{''}</i>Snap
      </button>
      <span class="tb-sep" />
      <button class="icon-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo()} onClick={undo}>
        <i class="ic">{''}</i>
      </button>
      <button class="icon-btn" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!canRedo()} onClick={redo}>
        <i class="ic">{''}</i>
      </button>
      <span class="spacer" />
      {st.plugin && (
        <div class="seg" role="group" aria-label="Behind the canvas">
          <button aria-pressed={st.mirror} title="Show what OBS is showing right now, behind the canvas" onClick={() => setMirror(true)}>
            <i class="ic">{''}</i>Live from OBS
          </button>
          <button aria-pressed={!st.mirror} title="Hold the picture still while you edit" onClick={() => setMirror(false)}>
            <i class="ic">{''}</i>Hold picture
          </button>
        </div>
      )}
      <span class="tb-label">Preview</span>
      <button
        class="icon-btn"
        title={st.playing ? 'Pause the sample track' : 'Play the sample track'}
        aria-label={st.playing ? 'Pause the sample track' : 'Play the sample track'}
        onClick={() => set({ playing: !st.playing })}
      >
        <i class="ic">{st.playing ? '' : ''}</i>
      </button>
    </div>
  );
}

function Status() {
  const st = useStore();
  const sel = selected();
  let text = 'Nothing selected.';
  if (st.tool === 'draw') text = 'Drag on the canvas to draw a no-go zone. Esc stops.';
  else if (st.chaosSel) text = 'Chaos: click an edge of the canvas to let him in from that side, or keep him out.';
  else if (sel.length === 1) {
    const r = sel[0].rect;
    text = `${sel[0].name}: x ${r.x}, y ${r.y}, ${r.w} x ${r.h} px` + (sel[0].locked ? '. Locked.' : '');
  } else if (sel.length > 1) text = `${sel.length} selected.`;
  return (
    <div class="statusline">
      <span class="status-text">{text}</span>
      <span class="keys">
        <kbd>Arrows</kbd> nudge <kbd>Shift</kbd> keeps the shape <kbd>Alt</kbd> skips snapping <kbd>[</kbd> <kbd>]</kbd> back and forward{' '}
        <kbd>Del</kbd> removes
      </span>
    </div>
  );
}

// Chaos's head from the overlay art (wwwroot/chaos/art/peek.png), cut to 64 px so the editor does
// not load the full picture for an icon.
const CHAOS = 'chaos';

function Sources() {
  const st = useStore();
  const row = (which: keyof Urls, name: string, icon: string, tone: string, hint?: string) => (
    <div class="src-row" title={hint}>
      <span class={'src-ic ' + tone}>
        {icon === CHAOS ? <img class="src-mark" src={chaosHead} alt="" /> : <i class="ic">{icon}</i>}
      </span>
      <span class="src-name">{name}</span>
      <code class="src-url">{st.urls[which]}</code>
      <button class={'btn copy' + (st.copied === which ? ' is-done' : '')} onClick={() => copyUrl(which)}>
        <i class="ic">{st.copied === which ? '' : ''}</i>
        <span>{st.copied === which ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
  return (
    <div class="card sources">
      <div class="card-head">
        <i class="ic">{''}</i>
        <div>
          <div class="card-title">Browser sources</div>
          <div class="caption">Add these to OBS once, 1920 x 1080 over the whole scene. Your layout shows in the Overlay source and updates as you edit.</div>
          {st.plugin && (
            <div class="src-plugin">
              <i class="ic">{''}</i>Your overlay starts with OBS. ChaosBot can connect to it when you use both.
            </div>
          )}
        </div>
      </div>
      {row('chaos', 'Overlay', '', 'src-ic-w')}
      {row('spotify', 'Spotify card', '', 'src-ic-sp', 'Only if you want the card as its own source. Not needed when it is in your layout.')}
    </div>
  );
}

export function App() {
  const st = useStore();
  return (
    <main class="page standalone">
      <Connections />
      <div class="page-head">
        <div>
          <h1>Overlay</h1>
          <p class="caption">Build your stream overlay. Changes appear in OBS as you edit.</p>
        </div>
        <div class="head-right">
          <Saved />
          <button class="btn" onClick={openSettings}>
            <i class="ic">{''}</i>Connections
          </button>
        </div>
      </div>
      {!st.loaded ? (
        <div class="loading" role="status">
          Loading your overlay
        </div>
      ) : (
        <div class="work">
          <section class="col-canvas">
            <LayoutStrip />
            {st.describe.open && <DescribePanel />}
            {st.draft && st.draft.id === scene().id ? <DraftBar /> : <LayoutBar />}
            <Toolbar />
            <div class="canvas-fit">
              <Canvas />
            </div>
            <Status />
            <Sources />
          </section>
          <aside class="col-side">
            <Elements />
            <Props />
          </aside>
        </div>
      )}
    </main>
  );
}
