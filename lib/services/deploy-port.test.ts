import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { composePort, hashPortFor, resolveDeployPort, rewriteComposePort, routePorts } from './deploy-port';

const nodeCompose = `services:
  app:
    environment:
      - NODE_ENV=production
      - PORT=3561
      - HOST=0.0.0.0
      - NITRO_PORT=3561
    env_file:
      - .env
`;

const never = async () => false;
const taken = (...ports: number[]) => ({ others: new Set(ports), own: new Set<number>() });

describe('composePort / rewriteComposePort', () => {
  it('reads and moves the node PORT and NITRO_PORT lines', () => {
    expect(composePort(nodeCompose)).toBe(3561);
    const moved = rewriteComposePort(nodeCompose, 3561, 3600);
    expect(moved).toContain('- PORT=3600');
    expect(moved).toContain('- NITRO_PORT=3600');
    expect(moved).toContain('- HOST=0.0.0.0');
  });

  it('handles the published-port form of the laravel compose', () => {
    const laravel = 'services:\n  app:\n    ports:\n      - "3620:80"\n';
    expect(composePort(laravel)).toBe(3620);
    expect(rewriteComposePort(laravel, 3620, 3621)).toContain('- "3621:80"');
  });

  it('returns null when there is no port line', () => {
    expect(composePort('services: {}\n')).toBeNull();
  });
});

describe('resolveDeployPort', () => {
  it('keeps the compose port when no other site routes to it', async () => {
    const port = await resolveDeployPort('incidentmanagement', 3762, { routes: taken(3561), isListening: never });
    expect(port).toBe(3762);
  });

  it('moves away from a port another site already routes to', async () => {
    const port = await resolveDeployPort('incidentmanagement', 3561, { routes: taken(3561), isListening: never });
    expect(port).not.toBe(3561);
  });

  it('skips taken, listening and preview ports when picking a new one', async () => {
    const guess = hashPortFor('newsite');
    const listening = new Set([guess + 1]);
    const port = await resolveDeployPort('newsite', null, {
      routes: taken(guess),
      isListening: async (p) => listening.has(p),
    });
    expect([guess, guess + 1]).not.toContain(port);
    expect(port >= 3710 && port <= 3799).toBe(false);
  });

  it('prefers the port of its own route when the compose port is taken', async () => {
    const port = await resolveDeployPort('incidentmanagement', 3561, {
      routes: { others: new Set([3561]), own: new Set([3602]) },
      isListening: async () => true,
    });
    expect(port).toBe(3602);
  });

  it('gives two names that hash to the same port different ports', async () => {
    const first = hashPortFor('incidentmanagement');
    const port = await resolveDeployPort('incidentmanagement', null, { routes: taken(first), isListening: never });
    expect(port).not.toBe(first);
  });
});

describe('routePorts', () => {
  it('splits ports of other sites from the own route', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routes-'));
    await fs.writeFile(path.join(dir, 'newstory.yml'), 'servers:\n  - url: "http://10.0.1.1:3561"\n');
    await fs.writeFile(path.join(dir, 'incidentmanagement.yml'), 'servers:\n  - url: "http://10.0.1.1:3602"\n');
    await fs.writeFile(path.join(dir, 'kennisbank.yaml'), 'servers:\n  - url: http://10.0.1.1:3721\n');
    const { others, own } = await routePorts('incidentmanagement', dir);
    expect([...others].sort()).toEqual([3561, 3721]);
    expect([...own]).toEqual([3602]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is empty when no route dir is configured', async () => {
    const { others, own } = await routePorts('x', '');
    expect(others.size + own.size).toBe(0);
  });
});
