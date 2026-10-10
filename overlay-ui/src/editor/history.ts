/* Undo history of whole-document snapshots. No imports, so `npm test` runs it under Node.

   - `commit` records the state before a change. Changes with the same coalesce key within
     COALESCE_MS make one step (typing a name, dragging a slider).
   - A gesture (a drag) records once at its end, and only if something moved.
   - `reset` drops everything: a document from outside (another window, a sync) is not undoable
     here, because undoing it would overwrite a change the streamer did not make in this editor. */

export const MAX_STEPS = 100;
export const COALESCE_MS = 600;

export class History<T> {
  past: T[] = [];
  future: T[] = [];
  private coalesce: { key: string; at: number } | null = null;

  /** Records `before` as an undo step for a change made at `now`. */
  record(before: T, now: number, key?: string): void {
    const merge = !!key && !!this.coalesce && this.coalesce.key === key && now - this.coalesce.at < COALESCE_MS;
    this.coalesce = key ? { key, at: now } : null;
    if (!merge) this.past = [...this.past, before].slice(-MAX_STEPS);
    this.future = [];
  }

  /** Ends any coalescing run, so the next change is its own step. */
  cut(): void {
    this.coalesce = null;
  }

  undo(current: T): T | null {
    const prev = this.past[this.past.length - 1];
    if (prev === undefined) return null;
    this.past = this.past.slice(0, -1);
    this.future = [current, ...this.future];
    this.coalesce = null;
    return prev;
  }

  redo(current: T): T | null {
    const next = this.future[0];
    if (next === undefined) return null;
    this.future = this.future.slice(1);
    this.past = [...this.past, current].slice(-MAX_STEPS);
    this.coalesce = null;
    return next;
  }

  reset(): void {
    this.past = [];
    this.future = [];
    this.coalesce = null;
  }
}
