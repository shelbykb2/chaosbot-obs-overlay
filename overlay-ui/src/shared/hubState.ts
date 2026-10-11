/** Retained feed state for widgets that mount after the page's shared socket connects. */
export class HubState {
  private values = new Map<string, unknown>();
  private goals = new Map<string, unknown>();
  private lines: Record<string, unknown>[] = [];

  remember(name: string, arg: unknown) {
    const o = arg && typeof arg === 'object' ? arg as Record<string, unknown> : {};
    if (name === 'goal' && typeof o.id === 'string') this.goals.set(o.id, arg);
    if (name === 'chatHistory') this.lines = Array.isArray(o.lines) ? o.lines.slice(-30) : [];
    if (name === 'chat' && o.line && typeof o.line === 'object') {
      const line = o.line as Record<string, unknown>;
      if (!this.lines.some((l) => l.id === line.id)) this.lines = [...this.lines, line].slice(-30);
    }
    if (name === 'chatClear') {
      if (o.all === true) this.lines = [];
      else if (typeof o.id === 'string' && o.id) this.lines = this.lines.filter((l) => l.id !== o.id);
      else if (typeof o.user === 'string' && o.user) this.lines = this.lines.filter((l) => String(l.user).toLowerCase() !== String(o.user).toLowerCase());
    }
    if (['chatHistory', 'chat', 'chatClear'].includes(name)) this.values.set('chatHistory', { lines: this.lines });
    if (['overlayConfig', 'nowPlaying', 'spotifyConfig', 'scene', 'scenePreview', 'commandFeed'].includes(name)) this.values.set(name, arg);
    if (name === 'scene') {
      const doc = o.doc as { scenes?: { elements?: { id: string; type: string }[] }[] } | undefined;
      const ids = new Set(doc?.scenes?.flatMap((s) => s.elements?.filter((e) => e.type === 'goal').map((e) => e.id) ?? []));
      for (const id of this.goals.keys()) if (!ids.has(id)) this.goals.delete(id);
    }
  }

  replay(handlers: Record<string, (arg: any) => void>) {
    for (const [name, arg] of this.values) handlers[name]?.(arg);
    for (const goal of this.goals.values()) handlers.goal?.(goal);
  }

  clear() { this.values.clear(); this.goals.clear(); this.lines = []; }
}
