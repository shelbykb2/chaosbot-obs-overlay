/**
 * Whether the bot now serves a newer build of this page than the one running.
 *
 * OBS keeps a browser source's page loaded for as long as the scene exists. When the bot restarts on a
 * new version, the hub reconnects but the page keeps its old code, so a setting the old code never
 * knew about (the cover shine, for one) seems to do nothing on stream while the editor's preview obeys
 * it. Vite names each script after a hash of its contents, so a different script name in the served
 * HTML means different code.
 */
export function moduleScripts(html: string): string[] {
  const found: string[] = [];
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype=["']?module\b/i.test(tag)) continue;
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag);
    if (src) found.push(src[1]);
  }
  return found;
}

/** Only a served page with scripts that are not the running ones counts; an error page or an empty answer never does. */
export function isStale(running: readonly string[], served: readonly string[]): boolean {
  if (running.length === 0 || served.length === 0) return false;
  return served.length !== running.length || served.some((s) => !running.includes(s));
}
