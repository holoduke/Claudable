/**
 * The shared it-ops MCP broker — an IN-PROCESS MCP server exposing a fixed,
 * allowlisted set of infra tools to the agent, but ONLY for projects where an
 * admin enabled it-ops mode (see claude.ts wiring).
 *
 * SECURITY MODEL (deliberate):
 *  - The tools run inside the Claudable process, NOT in the agent. The agent
 *    calls a tool and receives only its result — it never sees credentials, and
 *    the scrubbed agent env (buildAgentEnv) is unchanged.
 *  - WRITE tools are SCOPED to the box/dev plane (Gitea, Coolify, Traefik) and to
 *    specific verbs — not a raw API/shell passthrough. The AWS/IAM cloud plane
 *    stays PROPOSE-ONLY (propose_infra_change / propose_new_app_host): the agent
 *    can draft a reviewable plan but never touches AWS directly.
 *  - Every invocation is logged.
 */
import tls from 'tls';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { listDeployTargets } from './deploy-targets';
import { isBlockedHost, fetchWithTimeout } from './net';
import * as gitea from './gitea-ops';
import * as giteaAdmin from './gitea-admin-ops';
import * as coolify from './coolify-ops';
import * as traefik from './traefik-ops';

/** Wrap a write op so a thrown error comes back as a clean tool result, not a crash. */
async function run(fn: () => Promise<string>): Promise<{ content: { type: 'text'; text: string }[] }> {
  try {
    return text(await fn());
  } catch (e) {
    return text(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

function audit(toolName: string, args: unknown) {
  console.log(`[itops] tool=${toolName} args=${JSON.stringify(args)}`);
}

/** Reachability + TLS-cert health for a hostname (read-only, no creds). */
async function checkHost(host: string): Promise<string> {
  const clean = host.replace(/^https?:\/\//u, '').replace(/\/.*$/u, '').replace(/:\d+$/u, '');
  // Refuse internal/loopback/link-local targets so this can't be used for SSRF
  // recon (IMDS, localhost services, RFC-1918). See net.ts.
  if (isBlockedHost(clean)) return `${clean}: blocked (internal/loopback address not allowed)`;
  let http = 'n/a';
  try {
    const res = await fetchWithTimeout(`https://${clean}/`, { method: 'HEAD', redirect: 'manual' }, 6000);
    http = String(res.status);
  } catch (e) {
    http = `unreachable (${e instanceof Error ? e.message : 'error'})`;
  }
  const certInfo = await new Promise<string>((resolve) => {
    const socket = tls.connect({ host: clean, port: 443, servername: clean, timeout: 6000 }, () => {
      const c = socket.getPeerCertificate();
      const issuer = c?.issuer?.O || c?.issuer?.CN || 'unknown';
      const validTo = c?.valid_to || 'unknown';
      const authorized = socket.authorized;
      socket.end();
      resolve(`cert: issuer=${issuer}, validTo=${validTo}, trusted=${authorized}`);
    });
    socket.on('error', (err) => resolve(`cert: error (${err.message})`));
    socket.on('timeout', () => { socket.destroy(); resolve('cert: timeout'); });
  });
  return `${clean}: https ${http}; ${certInfo}`;
}

export function buildItopsMcpServer() {
  return createSdkMcpServer({
    name: 'itops',
    version: '0.1.0',
    tools: [
      tool(
        'list_deploy_targets',
        'List the deploy targets (boxes/domains) apps can be published to.',
        {},
        async (_args) => {
          audit('list_deploy_targets', {});
          const targets = listDeployTargets();
          if (!targets.length) return text('No deploy targets configured.');
          return text(targets.map((t) => `- ${t.id}: ${t.name} (domain ${t.domain})${t.notes ? ` — ${t.notes}` : ''}`).join('\n'));
        },
      ),
      tool(
        'infra_health',
        'Read-only health of deployment infra: HTTP reachability + TLS cert (issuer/expiry/trust) for a hostname. Pass a host (e.g. myapp.example.tf) or omit to check the deploy targets.',
        { host: z.string().optional() },
        async (args) => {
          audit('infra_health', args);
          if (args.host) return text(await checkHost(args.host));
          const targets = listDeployTargets();
          if (!targets.length) return text('No deploy targets configured to check.');
          const lines = await Promise.all(targets.map((t) => checkHost(`coolify.${t.domain}`).catch((e) => `${t.domain}: ${e}`)));
          return text(lines.join('\n'));
        },
      ),
      tool(
        'propose_new_app_host',
        'Propose provisioning a NEW app-host box (like box1: Docker + Coolify + Traefik with keyless Route53 DNS-01). Produces a concrete, reviewable plan — it does NOT create anything.',
        {
          domain: z.string().describe('Apex domain apps will live under, e.g. example.tf'),
          notes: z.string().optional().describe('Why / any specifics'),
        },
        async (args) => {
          audit('propose_new_app_host', args);
          const plan = [
            `PROPOSAL — new app-host for *.${args.domain} (NOT applied; for it-ops review)`,
            args.notes ? `Notes: ${args.notes}` : '',
            '',
            'Use the reproducible bundle: itops/provision-app-host/ (provision-app-host.sh + README.md).',
            'Steps (full detail + IAM policy in the README):',
            `  1. Run provision-app-host.sh with APP_DOMAIN=${args.domain} (installs Docker + Coolify + Traefik).`,
            '  2. Create the least-privilege Route53 DNS-01 IAM role and attach its instance profile to the box.',
            '  3. Set IMDS to IMDSv2 + hop-limit >= 2 (so the proxy container can reach the role).',
            `  4. Configure the Coolify proxy KEYLESS: env AWS_REGION + AWS_HOSTED_ZONE_ID only (NO static keys) + the route53 resolver flags; restart the proxy.`,
            `  5. Add wildcard DNS *.${args.domain} -> the box public IP (Route53).`,
            `  6. Register it in Claudable via ITOPS_DEPLOY_TARGETS.`,
            '',
            'CRITICAL: keep it keyless — static AWS keys + the org ForceMFA policy break cert renewals (the box1 trap).',
          ].filter(Boolean).join('\n');
          return text(plan);
        },
      ),
      // ---- Gitea (dev plane): real read/write via Claudable's existing token ----
      tool(
        'gitea_list_repos',
        'List Git repositories (in the configured org, or pass an owner).',
        { owner: z.string().optional() },
        async (args) => { audit('gitea_list_repos', args); return run(() => gitea.listRepos(args.owner)); },
      ),
      tool(
        'gitea_read_file',
        'Read a file from a Git repo.',
        { repo: z.string(), path: z.string(), ref: z.string().optional(), owner: z.string().optional() },
        async (args) => { audit('gitea_read_file', { repo: args.repo, path: args.path }); return run(() => gitea.readFile(args.repo, args.path, args.ref, args.owner)); },
      ),
      tool(
        'gitea_write_file',
        'Create or update a file in a Git repo (commits it). Optionally on a branch.',
        { repo: z.string(), path: z.string(), content: z.string(), message: z.string(), branch: z.string().optional(), owner: z.string().optional() },
        async (args) => { audit('gitea_write_file', { repo: args.repo, path: args.path, branch: args.branch }); return run(async () => (await gitea.writeFile(args.repo, args.path, args.content, args.message, args.branch, args.owner)).message); },
      ),
      tool(
        'gitea_create_repo',
        'Create a new Git repository (under the configured org).',
        { name: z.string(), private: z.boolean().optional(), description: z.string().optional() },
        async (args) => { audit('gitea_create_repo', { name: args.name }); return run(async () => (await gitea.createRepo(args.name, { private: args.private, description: args.description })).message); },
      ),

      // ---- Gitea ADMIN: repo admin, access control, org/team admin ----
      tool(
        'gitea_delete_repo',
        'Delete a Git repository. Irreversible.',
        { repo: z.string(), owner: z.string().optional() },
        async (args) => { audit('gitea_delete_repo', args); return run(() => giteaAdmin.deleteRepo(args.repo, args.owner)); },
      ),
      tool(
        'gitea_edit_repo',
        'Edit repo settings: visibility (private), description, default branch, archived.',
        { repo: z.string(), private: z.boolean().optional(), description: z.string().optional(), default_branch: z.string().optional(), archived: z.boolean().optional(), owner: z.string().optional() },
        async (args) => { audit('gitea_edit_repo', { repo: args.repo }); const { repo, owner, ...s } = args; return run(() => giteaAdmin.editRepo(repo, s, owner)); },
      ),
      tool(
        'gitea_list_collaborators',
        'List a repo\'s collaborators.',
        { repo: z.string(), owner: z.string().optional() },
        async (args) => { audit('gitea_list_collaborators', args); return run(() => giteaAdmin.listCollaborators(args.repo, args.owner)); },
      ),
      tool(
        'gitea_add_collaborator',
        'Grant a user access to a repo (set their permission). permission = read | write | admin.',
        { repo: z.string(), username: z.string(), permission: z.enum(['read', 'write', 'admin']), owner: z.string().optional() },
        async (args) => { audit('gitea_add_collaborator', { repo: args.repo, username: args.username, permission: args.permission }); return run(() => giteaAdmin.addCollaborator(args.repo, args.username, args.permission, args.owner)); },
      ),
      tool(
        'gitea_remove_collaborator',
        'Revoke a user\'s access to a repo.',
        { repo: z.string(), username: z.string(), owner: z.string().optional() },
        async (args) => { audit('gitea_remove_collaborator', { repo: args.repo, username: args.username }); return run(() => giteaAdmin.removeCollaborator(args.repo, args.username, args.owner)); },
      ),
      tool(
        'gitea_list_branch_protections',
        'List a repo\'s branch protection rules.',
        { repo: z.string(), owner: z.string().optional() },
        async (args) => { audit('gitea_list_branch_protections', args); return run(() => giteaAdmin.listBranchProtections(args.repo, args.owner)); },
      ),
      tool(
        'gitea_set_branch_protection',
        'Protect a branch: optionally require N approvals and/or block direct pushes (force PRs).',
        { repo: z.string(), branch: z.string(), requiredApprovals: z.number().optional(), blockPush: z.boolean().optional(), owner: z.string().optional() },
        async (args) => { audit('gitea_set_branch_protection', { repo: args.repo, branch: args.branch }); return run(() => giteaAdmin.setBranchProtection(args.repo, args.branch, { requiredApprovals: args.requiredApprovals, blockPush: args.blockPush }, args.owner)); },
      ),
      tool(
        'gitea_list_teams',
        'List the org\'s teams.',
        { org: z.string().optional() },
        async (args) => { audit('gitea_list_teams', args); return run(() => giteaAdmin.listTeams(args.org)); },
      ),
      tool(
        'gitea_list_org_members',
        'List the org\'s members.',
        { org: z.string().optional() },
        async (args) => { audit('gitea_list_org_members', args); return run(() => giteaAdmin.listOrgMembers(args.org)); },
      ),
      tool(
        'gitea_create_team',
        'Create an org team. permission = read | write | admin.',
        { name: z.string(), permission: z.enum(['read', 'write', 'admin']), org: z.string().optional() },
        async (args) => { audit('gitea_create_team', { name: args.name, permission: args.permission }); return run(() => giteaAdmin.createTeam(args.name, args.permission, args.org)); },
      ),
      tool(
        'gitea_delete_team',
        'Delete an org team by name or id.',
        { team: z.string(), org: z.string().optional() },
        async (args) => { audit('gitea_delete_team', args); return run(() => giteaAdmin.deleteTeam(args.team, args.org)); },
      ),
      tool(
        'gitea_add_team_member',
        'Add a user to an org team.',
        { team: z.string(), username: z.string(), org: z.string().optional() },
        async (args) => { audit('gitea_add_team_member', { team: args.team, username: args.username }); return run(() => giteaAdmin.addTeamMember(args.team, args.username, args.org)); },
      ),
      tool(
        'gitea_remove_team_member',
        'Remove a user from an org team.',
        { team: z.string(), username: z.string(), org: z.string().optional() },
        async (args) => { audit('gitea_remove_team_member', { team: args.team, username: args.username }); return run(() => giteaAdmin.removeTeamMember(args.team, args.username, args.org)); },
      ),

      // ---- Coolify (box plane): scoped verbs, gated on COOLIFY_API_TOKEN ----
      tool(
        'coolify_list_apps',
        'List Coolify applications (name, uuid, status, fqdn).',
        {},
        async (_args) => { audit('coolify_list_apps', {}); if (!coolify.coolifyConfigured()) return text('Coolify not configured (set COOLIFY_API_TOKEN).'); return run(() => coolify.listApps()); },
      ),
      tool(
        'coolify_restart_app',
        'Restart a Coolify application by name or uuid.',
        { app: z.string() },
        async (args) => { audit('coolify_restart_app', args); if (!coolify.coolifyConfigured()) return text('Coolify not configured (set COOLIFY_API_TOKEN).'); return run(() => coolify.restartApp(args.app)); },
      ),
      tool(
        'coolify_deploy_app',
        'Trigger a (re)deploy of a Coolify application by name or uuid.',
        { app: z.string() },
        async (args) => { audit('coolify_deploy_app', args); if (!coolify.coolifyConfigured()) return text('Coolify not configured (set COOLIFY_API_TOKEN).'); return run(() => coolify.deployApp(args.app)); },
      ),
      tool(
        'coolify_get_envs',
        'List a Coolify app\'s env var keys (secret values are masked).',
        { app: z.string() },
        async (args) => { audit('coolify_get_envs', args); if (!coolify.coolifyConfigured()) return text('Coolify not configured (set COOLIFY_API_TOKEN).'); return run(() => coolify.getEnvs(args.app)); },
      ),
      tool(
        'coolify_set_env',
        'Set (create or update) one env var on a Coolify app. Redeploy to apply.',
        { app: z.string(), key: z.string(), value: z.string() },
        async (args) => { audit('coolify_set_env', { app: args.app, key: args.key }); if (!coolify.coolifyConfigured()) return text('Coolify not configured (set COOLIFY_API_TOKEN).'); return run(() => coolify.setEnv(args.app, args.key, args.value)); },
      ),
      tool(
        'coolify_list_projects',
        'List Coolify projects (top-level containers for environments/resources).',
        {},
        async (_args) => { audit('coolify_list_projects', {}); if (!coolify.coolifyConfigured()) return text('Coolify not configured (set COOLIFY_API_TOKEN).'); return run(() => coolify.listProjects()); },
      ),
      tool(
        'coolify_create_project',
        'Create a new Coolify project. Returns its uuid.',
        { name: z.string(), description: z.string().optional() },
        async (args) => { audit('coolify_create_project', { name: args.name }); if (!coolify.coolifyConfigured()) return text('Coolify not configured (set COOLIFY_API_TOKEN).'); return run(() => coolify.createProject(args.name, args.description)); },
      ),
      tool(
        'coolify_delete_project',
        'Delete a Coolify project by name or uuid. Coolify refuses if the project still holds resources (it must be empty first).',
        { project: z.string() },
        async (args) => { audit('coolify_delete_project', args); if (!coolify.coolifyConfigured()) return text('Coolify not configured (set COOLIFY_API_TOKEN).'); return run(() => coolify.deleteProject(args.project)); },
      ),

      // ---- Traefik (box plane): dynamic route files, gated on the mounted dir ----
      tool(
        'traefik_list_routes',
        'List Traefik dynamic route files.',
        {},
        async (_args) => { audit('traefik_list_routes', {}); if (!(await traefik.traefikConfigured())) return text('Traefik dynamic dir not mounted (TRAEFIK_DYNAMIC_DIR).'); return run(() => traefik.listRoutes()); },
      ),
      tool(
        'traefik_read_route',
        'Read a Traefik dynamic route file by name (e.g. myapp.yml).',
        { name: z.string() },
        async (args) => { audit('traefik_read_route', args); if (!(await traefik.traefikConfigured())) return text('Traefik dynamic dir not mounted (TRAEFIK_DYNAMIC_DIR).'); return run(() => traefik.readRoute(args.name)); },
      ),
      tool(
        'traefik_write_route',
        'Write a Traefik dynamic route file (router+service YAML). Traefik hot-reloads it; HTTPS via the existing Route53 resolver. Filename must be lowercase + end .yml.',
        { name: z.string(), yaml: z.string() },
        async (args) => { audit('traefik_write_route', { name: args.name }); if (!(await traefik.traefikConfigured())) return text('Traefik dynamic dir not mounted (TRAEFIK_DYNAMIC_DIR).'); return run(() => traefik.writeRoute(args.name, args.yaml)); },
      ),
      tool(
        'traefik_remove_route',
        'Remove a Traefik dynamic route file by name (withdraws its route).',
        { name: z.string() },
        async (args) => { audit('traefik_remove_route', args); if (!(await traefik.traefikConfigured())) return text('Traefik dynamic dir not mounted (TRAEFIK_DYNAMIC_DIR).'); return run(() => traefik.removeRoute(args.name)); },
      ),

      tool(
        'propose_infra_change',
        'Record a PROPOSED infrastructure change for human review (e.g. provision a box, an AWS/IAM or DNS change). This does NOT apply anything — it produces a reviewable proposal. Use this for any change to AWS/IAM or anything outside the Gitea/Coolify/Traefik write tools.',
        {
          title: z.string().describe('Short title of the change'),
          summary: z.string().describe('What and why'),
          plan: z.string().describe('Concrete steps / Terraform / config the change requires'),
        },
        async (args) => {
          audit('propose_infra_change', { title: args.title });
          console.log(`[itops] PROPOSAL: ${args.title}\n${args.summary}\n--- plan ---\n${args.plan}`);
          return text(
            `Proposal recorded for human review (NOT applied):\n\nTitle: ${args.title}\nSummary: ${args.summary}\n\nNext step: an admin/it-ops opens this as a reviewed change (e.g. a Terraform PR via Atlantis). Infra is never changed directly by the agent.`,
          );
        },
      ),
    ],
  });
}
