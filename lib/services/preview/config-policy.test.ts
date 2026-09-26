import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { enforcePreviewConfigPolicy } from './config-policy';
import type { PreviewConfig } from './config';

describe('preview config policy', () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcp-'));
    project = path.join(root, 'projects', 'p1');
    fs.mkdirSync(path.join(project, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(project, 'backend', 'Dockerfile'), 'FROM scratch\n');
    fs.writeFileSync(path.join(root, 'secret.db'), 'x');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const backend = (container: Record<string, unknown>): PreviewConfig =>
    ({ backend: { run: '', container: { dockerfile: 'backend/Dockerfile', port: 8080, ...container } } }) as unknown as PreviewConfig;

  it('keeps a backend whose Dockerfile and context live inside the project', async () => {
    const { cfg, notes } = await enforcePreviewConfigPolicy(backend({ context: '.' }), project, { customer: false });
    expect(cfg?.backend?.container?.dockerfile).toBe('backend/Dockerfile');
    expect(notes).toEqual([]);
  });

  it.each([
    ['a build context outside the project', { context: '../..' }],
    ['an absolute build context', { context: '/' }],
    ['a Dockerfile outside the project', { dockerfile: '../../secret.db' }],
    ['a watch dir outside the project', { dev: true, watchDir: '../..' }],
  ])('drops the backend for %s — for every project', async (_label, override) => {
    const { cfg, notes } = await enforcePreviewConfigPolicy(backend(override), project, { customer: false });
    expect(cfg?.backend).toBeUndefined();
    expect(notes.join(' ')).toMatch(/outside the project/);
  });

  it('drops a backend whose context is a symlink out of the project', async () => {
    fs.symlinkSync(root, path.join(project, 'escape'));
    const { cfg } = await enforcePreviewConfigPolicy(backend({ context: 'escape' }), project, { customer: false });
    expect(cfg?.backend).toBeUndefined();
  });

  it('customer: ignores a custom image and caps resources', async () => {
    const input = {
      frontend: { image: 'evil/miner:latest', memory: '64g', cpus: '16', dev: 'npm run dev' },
      backend: { run: '', container: { dockerfile: 'backend/Dockerfile', port: 8080, memory: '32g', cpus: '8', pidsLimit: 100000 } },
    } as unknown as PreviewConfig;
    const { cfg } = await enforcePreviewConfigPolicy(input, project, { customer: true });
    expect(cfg?.frontend?.image).toBeUndefined();
    expect(cfg?.frontend?.memory).toBe('2g');
    expect(cfg?.frontend?.cpus).toBe('2');
    expect(cfg?.frontend?.dev).toBe('npm run dev');
    expect(cfg?.backend?.container?.memory).toBe('1g');
    expect(cfg?.backend?.container?.cpus).toBe('1');
    expect(cfg?.backend?.container?.pidsLimit).toBe(256);
  });

  it('customer: keeps smaller resource requests as they are', async () => {
    const input = { frontend: { memory: '512m', cpus: '0.5' } } as unknown as PreviewConfig;
    const { cfg } = await enforcePreviewConfigPolicy(input, project, { customer: true });
    expect(cfg?.frontend?.memory).toBe('512m');
    expect(cfg?.frontend?.cpus).toBe('0.5');
  });

  it('internal projects keep a custom image and their resources', async () => {
    const input = { frontend: { image: 'node:24', memory: '4g', cpus: '4' } } as unknown as PreviewConfig;
    const { cfg } = await enforcePreviewConfigPolicy(input, project, { customer: false });
    expect(cfg?.frontend).toEqual({ image: 'node:24', memory: '4g', cpus: '4' });
  });

  it('passes a missing config through', async () => {
    expect((await enforcePreviewConfigPolicy(null, project, { customer: true })).cfg).toBeNull();
  });
});
