import { send } from './bridge';
import { parseAnswer, systemPrompt, userPrompt, validateDraft } from './describe';
import { clampBox } from './geometry';
import { LIMITS, newId } from './model';
import { REGISTRY } from './registry';
import { commit, get, set, toast } from './store';
import { editLayout } from './actions';

/* "Describe a layout": the panel's request, ChaosBot's answer, and the draft layout it becomes.
   A draft is an ordinary layout that is not live and has no triggers, so OBS never shows it until
   the streamer keeps it and puts it live. The checks live in describe.ts. */

/** At most this many elements in a described layout. More is clutter, not a layout. */
const MAX_DESCRIBED = 12;

/** OverlayCreatorViewModel.MaxDescribeSystem and MaxDescribeUser. */
const MAX_SYSTEM = 24000;
const MAX_USER = 8000;

/** What the answer in flight is for: a new layout, or a change to the draft with this id. */
let pending: { change: string | null } | null = null;

export function openDescribe(change = false) {
  const st = get();
  if (!change && st.doc.scenes.length >= LIMITS.maxScenes) {
    toast(`You can have up to ${LIMITS.maxScenes} layouts.`);
    return;
  }
  set({ describe: { open: true, change, error: '' } });
}

export function closeDescribe() {
  set({ describe: { ...get().describe, open: false, error: '' } });
}

export function describeLayout(words: string, picture: boolean) {
  const st = get();
  if (st.describing || !words.trim()) return;
  const draft = st.draft && st.describe.change ? st.doc.scenes.find((s) => s.id === st.draft!.id) : undefined;
  const system = systemPrompt([...REGISTRY.values()]);
  const user = userPrompt(words, st.category?.name ?? null, draft ? draft.elements : null);
  // ChaosBot ignores a request over these sizes without answering.
  if (system.length > MAX_SYSTEM || user.length > MAX_USER) {
    describeFailed('This draft is too big to change in words. Edit it by hand, or describe a new one.');
    return;
  }
  const ask = { change: draft ? draft.id : null };
  pending = ask;
  set({ describing: true, describe: { ...st.describe, error: '' } });
  send('describe', { system, user, picture: picture && !!st.still });
  // ChaosBot gives up after 60 s and says so. This only frees the panel if that answer never comes.
  setTimeout(() => {
    if (pending === ask) describeFailed('No answer came back. Try again.');
  }, 75_000);
}

/** ChaosBot's answer: the model's raw text. */
export function described(text: string) {
  const ask = pending;
  pending = null;
  set({ describing: false });
  if (!ask) return;
  const draft = validateDraft(parseAnswer(text), [...REGISTRY.values()], {
    clampBox,
    newId: (t) => newId(t),
    maxElements: MAX_DESCRIBED,
    maxName: LIMITS.maxName,
  });
  if (!draft || !draft.elements.length) {
    describeFailed('That did not come back as a layout. Try saying it another way.');
    return;
  }

  if (ask.change) {
    const id = ask.change;
    if (!get().doc.scenes.some((s) => s.id === id)) return;
    commit((d) => {
      const s = d.scenes.find((x) => x.id === id);
      if (s) s.elements = draft.elements;
    });
    editLayout(id);
    set({ draft: { id, dropped: draft.dropped }, describe: { open: false, change: false, error: '' } });
    return;
  }

  const doc = get().doc;
  if (doc.scenes.length >= LIMITS.maxScenes) {
    describeFailed(`You can have up to ${LIMITS.maxScenes} layouts.`);
    return;
  }
  const used = new Set(doc.scenes.map((s) => s.name));
  let name = draft.name;
  for (let i = 2; used.has(name); i++) name = `${draft.name} ${i}`;
  const id = newId('layout');
  commit((d) => d.scenes.push({ id, name, elements: draft.elements, showFor: [] }));
  editLayout(id);
  set({ draft: { id, dropped: draft.dropped }, describe: { open: false, change: false, error: '' } });
}

export function describeFailed(text: string) {
  pending = null;
  const st = get();
  set({ describing: false, describe: { ...st.describe, open: true, error: text || 'That did not work. Try again in a moment.' } });
}

/** The draft becomes a layout like any other. */
export function keepDraft() {
  set({ draft: null });
  toast('Kept. Pick a game or category so it goes live on its own, or make it live now.');
}

export function throwAwayDraft() {
  const d = get().draft;
  if (!d) return;
  set({ draft: null, describe: { open: false, change: false, error: '' } });
  commit((doc) => {
    if (doc.scenes.length > 1) doc.scenes = doc.scenes.filter((s) => s.id !== d.id);
  });
  if (get().editingId === d.id) set({ editingId: null, sel: [], chaosSel: false });
}
