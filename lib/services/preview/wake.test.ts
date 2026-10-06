import { describe, expect, it } from 'vitest';
import { createWakeLimiter, resolveWakeSlug, slugFromHost, wakeHostRegex, wakePage, wakeRouteYaml } from './wake';
import { previewSlug } from './routes';

const TMPL = 'https://preview-{project}.newstory.tf';

describe('wakeHostRegex / slugFromHost', () => {
  it('builds an anchored, escaped host regex from the template', () => {
    expect(wakeHostRegex(TMPL)).toBe('^preview-([a-z0-9-]+)\\.newstory\\.tf$');
  });
  it('extracts the slug, case- and port-insensitive', () => {
    expect(slugFromHost('preview-ticketchat.newstory.tf', TMPL)).toBe('ticketchat');
    expect(slugFromHost('Preview-TicketChat.newstory.tf:443', TMPL)).toBe('ticketchat');
  });
  it('rejects other hosts and look-alikes', () => {
    expect(slugFromHost('claudable.newstory.tf', TMPL)).toBeNull();
    expect(slugFromHost('preview-x.newstory.tf.evil.com', TMPL)).toBeNull();
    expect(slugFromHost('preview-x.newstoryXtf', TMPL)).toBeNull();
    expect(slugFromHost(null, TMPL)).toBeNull();
  });
  it('is off for port templates and bare {project} hosts', () => {
    expect(wakeHostRegex('https://preview-{port}.newstory.tf')).toBeNull();
    expect(wakeHostRegex('https://{project}.newstory.tf')).toBeNull();
    expect(slugFromHost('preview-x.newstory.tf', '')).toBeNull();
  });
});

describe('resolveWakeSlug', () => {
  const ids = ['ticketchat', 'Project_X'];
  it('maps frontend and -api hosts to the project', () => {
    expect(resolveWakeSlug('ticketchat', ids)).toEqual({ projectId: 'ticketchat', backend: false });
    expect(resolveWakeSlug('ticketchat-api', ids)).toEqual({ projectId: 'ticketchat', backend: true });
    expect(resolveWakeSlug(previewSlug('Project_X'), ids)?.projectId).toBe('Project_X');
  });
  it('returns null for unknown slugs', () => {
    expect(resolveWakeSlug('nope', ids)).toBeNull();
  });
});

describe('createWakeLimiter', () => {
  it('allows one attempt per project per retry window', () => {
    const allow = createWakeLimiter(10, 600_000, 60_000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('a', 59_999)).toBe(false);
    expect(allow('a', 60_000)).toBe(true);
  });
  it('caps cold starts globally', () => {
    const allow = createWakeLimiter(2, 600_000, 60_000);
    expect([allow('a', 0), allow('b', 0), allow('c', 0)]).toEqual([true, true, false]);
    expect(allow('c', 600_000)).toBe(true);
  });
});

describe('wakeRouteYaml / wakePage', () => {
  it('writes a priority-1 HostRegexp router with the regex verbatim', () => {
    const y = wakeRouteYaml('^preview-([a-z0-9-]+)\\.newstory\\.tf$', 'http://10.0.1.1:3700');
    expect(y).toContain("rule: 'HostRegexp(`^preview-([a-z0-9-]+)\\.newstory\\.tf$`)'");
    expect(y).toContain('priority: 1');
    expect(y).toContain('url: "http://10.0.1.1:3700"');
  });
  it('polls only while waiting', () => {
    expect(wakePage('starting')).toContain('/__claudable-wake/status');
    expect(wakePage('unknown')).not.toContain('<script');
  });
});
