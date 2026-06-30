/**
 * Gitea ADMIN operations for the it-ops broker — repo administration, access
 * control ("security"), and org/team administration.
 *
 * Runs IN the Claudable process; reuses the existing GIT_TOKEN (a Gitea
 * site-admin user with repo+org admin scope). Site-instance user management
 * (/admin/users) needs a token minted with the extra `admin` scope and is NOT
 * exposed here.
 *
 * Scoped verbs, not a raw API passthrough — each function is one administrative
 * action, and every call is audited by the broker.
 */
import { api, ownerOrThrow } from './gitea-ops';
import { getGitProviderConfig } from '../git-provider';

function org(o?: string): string {
  const resolved = o?.trim() || getGitProviderConfig().org;
  if (!resolved) throw new Error('No org: pass org or set GIT_ORG.');
  return resolved;
}

const enc = encodeURIComponent;

// ---- Repository administration ----------------------------------------------

export async function deleteRepo(repo: string, owner?: string): Promise<string> {
  const o = ownerOrThrow(owner);
  await api(`/repos/${enc(o)}/${enc(repo)}`, { method: 'DELETE' });
  return `Deleted repo ${o}/${repo}.`;
}

/** Edit repo settings — visibility ("private"), description, default branch, etc. */
export async function editRepo(
  repo: string,
  settings: { private?: boolean; description?: string; default_branch?: string; archived?: boolean },
  owner?: string,
): Promise<string> {
  const o = ownerOrThrow(owner);
  await api(`/repos/${enc(o)}/${enc(repo)}`, { method: 'PATCH', body: JSON.stringify(settings) });
  return `Updated ${o}/${repo}: ${Object.keys(settings).join(', ') || '(no changes)'}.`;
}

// ---- Access control ("set security") ----------------------------------------

export async function listCollaborators(repo: string, owner?: string): Promise<string> {
  const o = ownerOrThrow(owner);
  const cols = (await api(`/repos/${enc(o)}/${enc(repo)}/collaborators`)) as Array<{ login: string }>;
  if (!cols?.length) return `${o}/${repo}: no collaborators.`;
  return `${o}/${repo} collaborators:\n${cols.map((c) => `  - ${c.login}`).join('\n')}`;
}

/** Add or update a collaborator's permission. permission = read | write | admin. */
export async function addCollaborator(
  repo: string,
  username: string,
  permission: 'read' | 'write' | 'admin',
  owner?: string,
): Promise<string> {
  const o = ownerOrThrow(owner);
  await api(`/repos/${enc(o)}/${enc(repo)}/collaborators/${enc(username)}`, {
    method: 'PUT',
    body: JSON.stringify({ permission }),
  });
  return `Granted ${username} ${permission} on ${o}/${repo}.`;
}

export async function removeCollaborator(repo: string, username: string, owner?: string): Promise<string> {
  const o = ownerOrThrow(owner);
  await api(`/repos/${enc(o)}/${enc(repo)}/collaborators/${enc(username)}`, { method: 'DELETE' });
  return `Removed ${username} from ${o}/${repo}.`;
}

export async function listBranchProtections(repo: string, owner?: string): Promise<string> {
  const o = ownerOrThrow(owner);
  const rules = (await api(`/repos/${enc(o)}/${enc(repo)}/branch_protections`)) as Array<{
    branch_name?: string;
    rule_name?: string;
  }>;
  if (!rules?.length) return `${o}/${repo}: no branch protection rules.`;
  return `${o}/${repo} protected:\n${rules.map((r) => `  - ${r.rule_name || r.branch_name}`).join('\n')}`;
}

/** Protect a branch: optionally require N approvals and/or block direct pushes. */
export async function setBranchProtection(
  repo: string,
  branch: string,
  opts: { requiredApprovals?: number; blockPush?: boolean } = {},
  owner?: string,
): Promise<string> {
  const o = ownerOrThrow(owner);
  const body = {
    branch_name: branch,
    enable_push: opts.blockPush ? false : true,
    required_approvals: opts.requiredApprovals ?? 0,
    enable_approvals_whitelist: false,
    dismiss_stale_approvals: (opts.requiredApprovals ?? 0) > 0,
    require_signed_commits: false,
  };
  // Idempotent: PATCH the existing rule if there is one, else POST a new one
  // (a second POST for the same branch 422s in Gitea).
  const rules = (await api(`/repos/${enc(o)}/${enc(repo)}/branch_protections`)) as Array<{
    branch_name?: string;
    rule_name?: string;
  }>;
  const existing = rules.find((r) => (r.rule_name || r.branch_name) === branch);
  if (existing) {
    await api(`/repos/${enc(o)}/${enc(repo)}/branch_protections/${enc(branch)}`, { method: 'PATCH', body: JSON.stringify(body) });
  } else {
    await api(`/repos/${enc(o)}/${enc(repo)}/branch_protections`, { method: 'POST', body: JSON.stringify(body) });
  }
  return `Protected ${branch} on ${o}/${repo}` +
    `${opts.requiredApprovals ? `, require ${opts.requiredApprovals} approval(s)` : ''}` +
    `${opts.blockPush ? ', block direct push' : ''}.`;
}

// ---- Org / team administration ----------------------------------------------

export async function listTeams(o?: string): Promise<string> {
  const teams = (await api(`/orgs/${enc(org(o))}/teams`)) as Array<{ id: number; name: string; permission: string }>;
  if (!teams?.length) return 'No teams.';
  return teams.map((t) => `- ${t.name} [id ${t.id}] permission=${t.permission}`).join('\n');
}

export async function listOrgMembers(o?: string): Promise<string> {
  const members = (await api(`/orgs/${enc(org(o))}/members`)) as Array<{ login: string }>;
  if (!members?.length) return 'No members.';
  return members.map((m) => `- ${m.login}`).join('\n');
}

const DEFAULT_TEAM_UNITS = [
  'repo.code', 'repo.issues', 'repo.pulls', 'repo.releases', 'repo.wiki', 'repo.projects', 'repo.packages',
];

/** Create an org team. permission = read | write | admin (units are required for read/write). */
export async function createTeam(
  name: string,
  permission: 'read' | 'write' | 'admin',
  o?: string,
): Promise<string> {
  const created = (await api(`/orgs/${enc(org(o))}/teams`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      permission,
      units: DEFAULT_TEAM_UNITS,
      can_create_org_repo: permission === 'admin',
      includes_all_repositories: false,
    }),
  })) as { id: number };
  return `Created team "${name}" [id ${created.id}] (${permission}).`;
}

/** Resolve a team name (or numeric id string) to its id via the list endpoint. */
async function teamId(team: string, o?: string): Promise<number> {
  if (/^\d+$/u.test(team)) return Number(team);
  const teams = (await api(`/orgs/${enc(org(o))}/teams`)) as Array<{ id: number; name: string }>;
  const match = teams.find((t) => t.name.toLowerCase() === team.toLowerCase());
  if (!match) throw new Error(`No team "${team}" in org.`);
  return match.id;
}

export async function deleteTeam(team: string, o?: string): Promise<string> {
  const id = await teamId(team, o);
  await api(`/teams/${id}`, { method: 'DELETE' });
  return `Deleted team ${team} [id ${id}].`;
}

export async function addTeamMember(team: string, username: string, o?: string): Promise<string> {
  const id = await teamId(team, o);
  await api(`/teams/${id}/members/${enc(username)}`, { method: 'PUT' });
  return `Added ${username} to team ${team} [id ${id}].`;
}

export async function removeTeamMember(team: string, username: string, o?: string): Promise<string> {
  const id = await teamId(team, o);
  await api(`/teams/${id}/members/${enc(username)}`, { method: 'DELETE' });
  return `Removed ${username} from team ${team} [id ${id}].`;
}
