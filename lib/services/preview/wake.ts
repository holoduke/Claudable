// Wake-on-visit for per-project preview subdomains.
//
// A stopped preview has no Traefik route, so its public URL used to answer
// "no available server". Claudable now keeps one low-priority catch-all route
// for every preview-<slug> host that points at Claudable itself: while a
// project's own route is missing, the visit lands here, we start the preview
// and serve a small "starting" page that reloads once the real route is live
// (the project's Host() router always outranks the catch-all).
import path from 'path';
import fs from 'fs/promises';
import { previewRouteDir, previewSlug } from './routes';
import { wakeHostRegex } from './wake-host';

export { slugFromHost, wakeHostRegex } from './wake-host';

/** Header on every wake response, so the waiting page can tell "still us" from "the app". */
export const WAKE_HEADER = 'x-claudable-wake';
/** Path the waiting page polls; served by the wake handler only while the route is missing. */
export const WAKE_STATUS_PATH = '/__claudable-wake/status';
const WAKE_ROUTE_FILE = 'claudable-preview-wake.yml';
const WAKE_ROUTE_MARKER = '# claudable-managed-preview-wake';

/** Which project (and which of its hosts) a slug belongs to. */
export function resolveWakeSlug(
  slug: string,
  projectIds: readonly string[],
): { projectId: string; backend: boolean } | null {
  for (const id of projectIds) {
    const s = previewSlug(id);
    if (s === slug) return { projectId: id, backend: false };
    if (`${s}-api` === slug) return { projectId: id, backend: true };
  }
  return null;
}

export function wakeRouteYaml(hostRegex: string, claudableUrl: string): string {
  return `${WAKE_ROUTE_MARKER}
# Catch-all for stopped previews: lands on Claudable, which starts the preview.
# Priority 1 keeps every per-project Host() route (and real app routes) ahead of it.
http:
  routers:
    claudable-preview-wake:
      # single-quoted: the regex backslashes must reach Traefik verbatim
      rule: 'HostRegexp(\`${hostRegex}\`)'
      priority: 1
      entryPoints: [https]
      service: claudable-preview-wake
      tls: {}
  services:
    claudable-preview-wake:
      loadBalancer:
        servers:
          - url: "${claudableUrl}"
`;
}

/** Write the catch-all route (on boot). No-op without per-project previews. */
export async function writeWakeRoute(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = previewRouteDir();
  const re = wakeHostRegex(env.PREVIEW_URL_TEMPLATE || '');
  if (!dir || !re || env.PREVIEW_WAKE === '0') return;
  const gw = env.DEPLOY_HOST_GATEWAY || 'host.docker.internal';
  const port = env.PORT || '3000';
  await fs.writeFile(path.join(dir, WAKE_ROUTE_FILE), wakeRouteYaml(re, `http://${gw}:${port}`), 'utf8')
    .catch((error) => console.warn('[PreviewWake] could not write the wake route:', error));
}

/**
 * Abuse guard: the wake URL is public, so cap how many cold starts anonymous
 * visitors can cause (each dev server holds 0.5-2 GB). Per project at most one
 * attempt per `retryMs`; globally at most `max` per `windowMs`.
 */
export function createWakeLimiter(max = 8, windowMs = 10 * 60_000, retryMs = 60_000) {
  let starts: number[] = [];
  const lastByProject = new Map<string, number>();
  return function allow(projectId: string, now = Date.now()): boolean {
    const last = lastByProject.get(projectId);
    if (last !== undefined && now - last < retryMs) return false;
    starts = starts.filter((t) => now - t < windowMs);
    if (starts.length >= max) return false;
    starts = [...starts, now];
    lastByProject.set(projectId, now);
    return true;
  };
}

export type WakeState = 'starting' | 'failed' | 'busy' | 'unknown';

const MESSAGES: Record<WakeState, { title: string; body: string }> = {
  starting: { title: 'Preview wordt gestart…', body: 'Deze preview stond uit. Hij start nu op; dat duurt meestal 10–30 seconden. De pagina laadt vanzelf.' },
  failed: { title: 'Preview kon niet starten', body: 'Open het project in Claudable om de fout te bekijken.' },
  busy: { title: 'Preview staat uit', body: 'Er worden nu te veel previews tegelijk gestart. Probeer het over een minuut opnieuw.' },
  unknown: { title: 'Preview niet gevonden', body: 'Er bestaat geen project bij dit adres.' },
};

/** Self-contained waiting page (no external assets: this host has none of its own). */
export function wakePage(state: WakeState): string {
  const m = MESSAGES[state];
  const poll = state === 'starting' || state === 'busy';
  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${m.title}</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--muted:#71717a;--accent:#6366f1}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:420px;text-align:center}h1{font-size:20px;margin:16px 0 8px}p{color:var(--muted);margin:0}
.s{width:28px;height:28px;margin:auto;border:3px solid color-mix(in srgb,var(--accent) 25%,transparent);border-top-color:var(--accent);border-radius:50%;animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(1turn)}}
</style></head><body><main>${poll ? '<div class="s" aria-hidden="true"></div>' : ''}
<h1 id="t">${m.title}</h1><p id="b">${m.body}</p></main>
${poll ? `<script>
(function(){var n=0;function tick(){n++;fetch(${JSON.stringify(WAKE_STATUS_PATH)},{cache:'no-store'}).then(function(r){
if(!r.headers.get(${JSON.stringify(WAKE_HEADER)})){location.reload();return;}
return r.json().then(function(j){if(j&&j.state==='failed'){document.getElementById('t').textContent=${JSON.stringify(MESSAGES.failed.title)};document.getElementById('b').textContent=${JSON.stringify(MESSAGES.failed.body)};document.querySelector('.s')&&document.querySelector('.s').remove();return;}
if(j&&j.state==='running'&&n>2){location.reload();return;}setTimeout(tick,n<20?2000:5000);});
}).catch(function(){setTimeout(tick,3000);});}setTimeout(tick,1500);})();
</script>` : ''}
</body></html>`;
}
