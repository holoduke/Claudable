import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILDER_NAME, buildInvocation, buildkitHost, resetBuilderSelection, selectBuilder } from './image-builder';

describe('buildInvocation', () => {
  const spec = { tag: 'img', dockerfile: 'Dockerfile', context: '-', sandboxNet: 'claudable-sandbox' };
  it('BuildKit: remote builder, loaded into docker, no --network (the builder lives on the sandbox net)', () => {
    const { args, env } = buildInvocation('buildkit', spec);
    expect(args).toEqual(['buildx', 'build', '--builder', BUILDER_NAME, '--load', '--progress', 'plain', '-t', 'img', '-f', 'Dockerfile', '-']);
    expect(env).toEqual({});
  });
  it('legacy: builds on the sandbox network with BuildKit explicitly off', () => {
    const { args, env } = buildInvocation('legacy', spec);
    expect(args).toEqual(['build', '--network', 'claudable-sandbox', '-t', 'img', '-f', 'Dockerfile', '-']);
    expect(env).toEqual({ DOCKER_BUILDKIT: '0' });
  });
});

describe('buildkitHost', () => {
  it('accepts only tcp://host:port', () => {
    expect(buildkitHost({ PREVIEW_BUILDKIT_HOST: 'tcp://127.0.0.1:1234' })).toBe('tcp://127.0.0.1:1234');
    expect(buildkitHost({ PREVIEW_BUILDKIT_HOST: 'unix:///run/x.sock' })).toBeNull();
    expect(buildkitHost({ PREVIEW_BUILDKIT_HOST: 'tcp://x:1; rm -rf /' })).toBeNull();
    expect(buildkitHost({})).toBeNull();
  });
});

describe('selectBuilder', () => {
  const HOST = 'tcp://127.0.0.1:1234';
  beforeEach(() => {
    resetBuilderSelection();
    vi.stubEnv('PREVIEW_BUILDKIT_HOST', HOST);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllEnvs());

  const running = `Name: ${BUILDER_NAME}\nDriver: remote\nNodes:\nName: ${BUILDER_NAME}0\nEndpoint: ${HOST}\nStatus: running\n`;

  it('uses BuildKit when the builder exists and answers', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return { code: 0, out: running }; };
    expect((await selectBuilder(run)).mode).toBe('buildkit');
    expect(calls.map((c) => c.slice(0, 3).join(' '))).toEqual([`buildx inspect ${BUILDER_NAME}`, 'buildx inspect --bootstrap']);
  });

  it('creates the builder when missing or pointing elsewhere', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[1] === 'inspect' && args[2] === BUILDER_NAME) return { code: 1, out: 'no builder found' };
      return { code: 0, out: running };
    };
    expect((await selectBuilder(run)).mode).toBe('buildkit');
    expect(calls.some((c) => c.join(' ') === `buildx create --name ${BUILDER_NAME} --driver remote ${HOST}`)).toBe(true);
  });

  it('falls back to legacy when buildkitd does not answer, or when not configured', async () => {
    const down = async (args: string[]) => (args.includes('--bootstrap') ? { code: 1, out: 'connection refused' } : { code: 0, out: running });
    const r = await selectBuilder(down);
    expect(r.mode).toBe('legacy');
    expect(r.reason).toMatch(/not reachable/);

    resetBuilderSelection();
    vi.stubEnv('PREVIEW_BUILDKIT_HOST', '');
    expect((await selectBuilder(async () => ({ code: 0, out: running }))).mode).toBe('legacy');
  });

  it('probes once for concurrent callers and caches for a minute', async () => {
    let probes = 0;
    let t = 0;
    const run = async (args: string[]) => { if (args.includes('--bootstrap')) probes += 1; return { code: 0, out: running }; };
    await Promise.all([selectBuilder(run, () => t), selectBuilder(run, () => t), selectBuilder(run, () => t)]);
    expect(probes).toBe(1);
    t = 30_000;
    await selectBuilder(run, () => t);
    expect(probes).toBe(1);
    t = 61_000;
    await selectBuilder(run, () => t);
    expect(probes).toBe(2);
  });
});
