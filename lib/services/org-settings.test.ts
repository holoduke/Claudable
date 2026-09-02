import { beforeEach, describe, expect, it, vi } from 'vitest';

// Org-level settings: the create-projects switch and the org Claude credential
// (resolution order + env var choice). Prisma and crypto are mocked.
const orgs: Record<string, { canCreateProjects: boolean; claudeCredentialId: string | null }> = {};
const projects: Record<string, { claudeCredentialId: string | null; orgId: string | null }> = {};
const creds: Record<string, { id: string; ownerId: string; shareable: boolean; token: string; orgBound?: boolean }> = {};
const ownCred: Record<string, string> = {}; // userId -> credId (most recent personal or org-bound row)

vi.mock('@/lib/db/client', () => ({
  prisma: {
    organization: { findUnique: vi.fn(async ({ where }: any) => orgs[where.id] ?? null) },
    project: { findUnique: vi.fn(async ({ where }: any) => projects[where.id] ?? null) },
    claudeCredential: {
      findUnique: vi.fn(async ({ where }: any) => creds[where.id] ?? null),
      findFirst: vi.fn(async ({ where }: any) => {
        const c = ownCred[where.ownerId] ? creds[ownCred[where.ownerId]] : null;
        // Mirror Prisma's `organizations: { none: {} }` filter.
        if (c && where.organizations?.none && c.orgBound) return null;
        return c;
      }),
      update: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('@/lib/crypto', () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') }));
vi.mock('@/lib/auth/session', () => ({ getSessionUser: vi.fn() }));

import { credentialEnvName, resolveProjectClaudeToken, runUsesRequestersOwnAccount } from './claude-credentials';
import { orgAllowsProjectCreation } from './org-access';

beforeEach(() => {
  for (const o of [orgs, projects, creds, ownCred]) for (const k of Object.keys(o)) delete (o as any)[k];
  orgs['org-a'] = { canCreateProjects: true, claudeCredentialId: null };
  orgs['org-b'] = { canCreateProjects: false, claudeCredentialId: 'c-org' };
  creds['c-org'] = { id: 'c-org', ownerId: 'root', shareable: false, token: 'enc:sk-ant-api03-ORG' };
  projects['p-a'] = { claudeCredentialId: null, orgId: 'org-a' };
  projects['p-b'] = { claudeCredentialId: null, orgId: 'org-b' };
});

describe('create-projects switch', () => {
  it('reflects the org flag and is closed for unknown orgs', async () => {
    expect(await orgAllowsProjectCreation('org-a')).toBe(true);
    expect(await orgAllowsProjectCreation('org-b')).toBe(false);
    expect(await orgAllowsProjectCreation('nope')).toBe(false);
  });
});

describe('credential env var', () => {
  it('routes API keys to ANTHROPIC_API_KEY and OAuth tokens to CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(credentialEnvName('sk-ant-api03-abc')).toBe('ANTHROPIC_API_KEY');
    expect(credentialEnvName(' sk-ant-api03-abc ')).toBe('ANTHROPIC_API_KEY');
    expect(credentialEnvName('sk-ant-oat01-xyz')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(credentialEnvName('anything-else')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

describe('org credential in the resolution order', () => {
  it('is used when neither the project nor the requester brings a credential', async () => {
    expect(await resolveProjectClaudeToken('p-b', 'customer')).toBe('sk-ant-api03-ORG');
  });

  it('is NOT used for an org without one (falls through to the platform token)', async () => {
    expect(await resolveProjectClaudeToken('p-a', 'customer')).toBeNull();
  });

  it("loses to the requester's own credential", async () => {
    creds['c-own'] = { id: 'c-own', ownerId: 'customer', shareable: false, token: 'enc:sk-ant-oat01-OWN' };
    ownCred['customer'] = 'c-own';
    expect(await resolveProjectClaudeToken('p-b', 'customer')).toBe('sk-ant-oat01-OWN');
  });

  it('loses to a shareable project credential', async () => {
    creds['c-proj'] = { id: 'c-proj', ownerId: 'someone', shareable: true, token: 'enc:sk-ant-oat01-PROJ' };
    projects['p-b'].claudeCredentialId = 'c-proj';
    expect(await resolveProjectClaudeToken('p-b', 'customer')).toBe('sk-ant-oat01-PROJ');
  });

  it('never counts as the requester\'s own account (no connector passthrough)', async () => {
    expect(await runUsesRequestersOwnAccount('p-b', 'customer')).toBe(false);
  });

  it('is NOT treated as the personal credential of the admin who set it', async () => {
    // root set Micros.nl's credential; root's most recent owned row is that org credential.
    creds['c-org'].orgBound = true;
    ownCred['root'] = 'c-org';
    // In an org WITHOUT an org credential, root must fall through to the platform token,
    // not silently run on Micros.nl's account.
    expect(await resolveProjectClaudeToken('p-a', 'root')).toBeNull();
    expect(await runUsesRequestersOwnAccount('p-a', 'root')).toBe(false);
  });
});
