import { describe, expect, it } from 'vitest';
import vm from 'vm';
import { bridgeCoreSource, bridgeCoreBody, nuxtPluginSource, type BridgeOptions } from './bridge-script';

const base: Omit<BridgeOptions, 'route'> = { claudableOrigin: 'https://claudable.test', projectId: 'p1', logToken: 'tok' };

describe('nuxtPluginSource (unchanged Nuxt plugin)', () => {
  const src = nuxtPluginSource({ ...base, route: 'nuxt-router' });
  it('keeps the plugin wrapper, header and router hookup', () => {
    expect(src.startsWith('// Auto-added by Claudable (preview only).')).toBe(true);
    expect(src).toContain('export default defineNuxtPlugin(() => {\n  if (typeof window === \'undefined\' || window.parent === window) return;');
    expect(src.endsWith('  } catch {}\n});\n')).toBe(true);
    expect(src).toContain('const router = useRouter();');
    expect(src).toContain('postRoute(router.currentRoute.value.path);');
    expect(src).toContain('router.afterEach((to) => postRoute(to.path));');
    expect(src).not.toContain('pushState');
    expect(src).not.toContain('__claudablePreviewBridge');
  });
  it('keeps every bridge message/command and the baked-in identifiers', () => {
    for (const s of [
      "source: 'claudable-preview'", "source: 'claudable-editor', type: 'selected'", "d.source !== 'claudable-editor-cmd'",
      "d.type === 'applyStyle'", "d.type === 'applyText'", "d.source !== 'claudable-comments-cmd'", "type: 'pinPositions'",
      "type: 'pinClicked'", "type: 'placed'", "d.type === 'renderPins'", "d.type === 'scrollTo'", "source: 'claudable-errors'",
      "'/client-logs?t='", "addEventListener('unhandledrejection'", 'console.error = function', 'console.warn = function',
      'const CLAUDABLE_ORIGIN = "https://claudable.test";', 'const CLAUDABLE_PROJECT_ID = "p1";', 'const CLAUDABLE_LOG_TOKEN = "tok";',
      '.split(/[?#]/)[0]',
    ]) expect(src).toContain(s);
  });
});

describe('bridgeCoreSource (history routing)', () => {
  const src = bridgeCoreSource({ ...base, route: 'history' });
  it('is a self-contained IIFE that never closes a <script> element', () => {
    expect(() => new vm.Script(src)).not.toThrow();
    expect(src.toLowerCase()).not.toContain('</script');
    expect(src).not.toContain('useRouter');
  });
  it('shares the rest of the bridge verbatim with the Nuxt variant', () => {
    const nuxt = bridgeCoreBody({ ...base, route: 'nuxt-router' });
    const tail = nuxt.slice(nuxt.indexOf('  // --- visual editor bridge'));
    expect(bridgeCoreBody({ ...base, route: 'history' }).endsWith(tail)).toBe(true);
  });
});

/** Run the history bridge in a tiny fake browser and collect its postMessages. */
function runHistoryBridge(opts: { framed: boolean; path?: string }) {
  const posted: { msg: { source: string; path?: string }; target: string }[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const location = { pathname: opts.path ?? '/', ancestorOrigins: [] as string[] };
  const history = {
    pushState(_s: unknown, _t: string, url: string) { location.pathname = String(url).split(/[?#]/u)[0]; },
    replaceState(_s: unknown, _t: string, url: string) { location.pathname = String(url).split(/[?#]/u)[0]; },
  };
  const parent = { postMessage: (msg: { source: string; path?: string }, target: string) => posted.push({ msg, target }) };
  const win: Record<string, unknown> = {
    location, history,
    addEventListener: (t: string, f: (e: unknown) => void) => { (listeners[t] ||= []).push(f); },
  };
  win.parent = opts.framed ? parent : win;
  const ctx = vm.createContext({
    window: win, document: { referrer: '', addEventListener() {}, documentElement: { style: {} } },
    console: { error() {}, warn() {} }, setTimeout, clearTimeout, requestAnimationFrame: () => 0, fetch: () => Promise.resolve(),
  });
  const src = bridgeCoreSource({ ...base, route: 'history' });
  new vm.Script(src).runInContext(ctx);
  const routes = () => posted.filter((p) => p.msg.source === 'claudable-preview').map((p) => p.msg.path);
  const fire = (t: string) => (listeners[t] || []).forEach((f) => f({}));
  return { posted, routes, history, location, fire, run: () => new vm.Script(src).runInContext(ctx), listeners };
}

describe('history route reporter', () => {
  it('reports the initial path and push/replace navigations (pathname only, deduped)', () => {
    const b = runHistoryBridge({ framed: true, path: '/start' });
    b.history.pushState(null, '', '/about?x=1#top');
    b.history.replaceState(null, '', '/about?x=2');
    b.history.pushState(null, '', '/blog/post');
    expect(b.routes()).toEqual(['/start', '/about', '/blog/post']);
    expect(b.posted.every((p) => p.target === 'https://claudable.test')).toBe(true);
  });
  it('reports back/forward and hash navigations', () => {
    const b = runHistoryBridge({ framed: true, path: '/a' });
    b.location.pathname = '/b';
    b.fire('popstate');
    b.location.pathname = '/c';
    b.fire('hashchange');
    expect(b.routes()).toEqual(['/a', '/b', '/c']);
  });
  it('is inert outside an iframe', () => {
    const b = runHistoryBridge({ framed: false, path: '/x' });
    b.history.pushState(null, '', '/y');
    expect(b.posted).toEqual([]);
    expect(Object.keys(b.listeners)).toEqual([]);
  });
  it('installs only once when the script is loaded twice', () => {
    const b = runHistoryBridge({ framed: true, path: '/x' });
    const count = b.listeners.message.length;
    b.run();
    expect(b.listeners.message.length).toBe(count);
    b.history.pushState(null, '', '/y');
    expect(b.routes()).toEqual(['/x', '/y']);
  });
});
