/**
 * Build/deploy log of a project's latest CI run (Gitea Actions; GitHub as
 * fallback), cleaned up so people and the agent can read WHY a deploy failed
 * without a Gitea account:
 *  - ANSI colours and runner timestamps removed;
 *  - the runner's dump of the whole workflow script dropped (infra detail);
 *  - anything that looks like a credential masked (tokens in URLs, bearer/basic
 *    auth, known token prefixes, KEY=value secrets) — Gitea masks secrets it
 *    knows, but a build can print others;
 *  - error-ish lines extracted separately, plus the tail of the log.
 */
import { getProjectService } from './project-services';
import { getGitProviderConfig, getGitProviderConfigFor } from './git-provider';
import { githubFetch, resolveGitToken, projectBaseBranch } from './github';

export interface DeployLog {
  found: boolean;
  runNumber?: number;
  state?: 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'unknown';
  job?: string;
  title?: string;
  sha?: string;
  url?: string;
  /** Lines that look like the cause (errors, failures), in order. */
  errors: string[];
  /** The last part of the cleaned log. */
  tail: string;
  /** True when the log was longer than what is returned. */
  truncated: boolean;
}

const MAX_TAIL_LINES = 250;
const MAX_ERROR_LINES = 60;
const MAX_LINE = 600;

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;
const ERROR_RE = /\b(error|errors|failed|failure|fatal|exception|panic|cannot|could not|not found|denied|refused|timed out|ERR!|ELIFECYCLE|exit (?:code|status):? ?[1-9])\b|✗|❌|×\s|FAIL\b/i;
const NOISE_RE = /^(?:evaluating expression|expression '.*' (?:evaluated|rewritten)|\s*$)/i;

/** Mask anything credential-shaped. Exported for tests. */
export function redact(line: string): string {
  return line
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***:***@')
    .replace(/(https?:\/\/)[^\s/@:]{20,}@/gi, '$1***@')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 ***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|aih_[A-Za-z0-9_-]{20,}|clb_[A-Za-z0-9._-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '***')
    .replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/g, '$1=***');
}

/** Clean a raw runner log into readable lines. Exported for tests. */
export function cleanLog(raw: string): string[] {
  const out: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.replace(ANSI_RE, '').replace(TIMESTAMP_RE, '');
    // The runner echoes the full workflow script on one line ("Wrote command …").
    if (/^Wrote command /.test(line)) { out.push('[workflow-script weggelaten]'); continue; }
    if (NOISE_RE.test(line)) continue;
    line = redact(line);
    if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)} …`;
    out.push(line);
  }
  return out;
}

/** Errors + tail from cleaned lines. Exported for tests. */
export function summarize(lines: string[]): Pick<DeployLog, 'errors' | 'tail' | 'truncated'> {
  const errors: string[] = [];
  for (const l of lines) {
    if (ERROR_RE.test(l) && !errors.includes(l)) errors.push(l);
  }
  const tailLines = lines.slice(-MAX_TAIL_LINES);
  return {
    errors: errors.slice(-MAX_ERROR_LINES),
    tail: tailLines.join('\n'),
    truncated: lines.length > MAX_TAIL_LINES,
  };
}

const normalize = (status: string, conclusion?: string): DeployLog['state'] => {
  const s = (conclusion || status || '').toLowerCase();
  if (['success'].includes(s)) return 'success';
  if (['failure', 'error', 'timed_out', 'startup_failure'].includes(s)) return 'failure';
  if (['cancelled', 'canceled'].includes(s)) return 'cancelled';
  if (['running', 'in_progress'].includes(s)) return 'running';
  if (['waiting', 'queued', 'blocked', 'pending'].includes(s)) return 'queued';
  return 'unknown';
};

/**
 * The log of the newest deploy run on the project's base branch. Picks the
 * failed job when there is one, else the last job.
 */
export async function getDeployRunLog(projectId: string): Promise<DeployLog> {
  const empty: DeployLog = { found: false, errors: [], tail: '', truncated: false };
  const service = await getProjectService(projectId, 'github');
  const data = service?.serviceData as Record<string, any> | undefined;
  const owner = data?.owner as string | undefined;
  const repo = data?.repo_name as string | undefined;
  if (!owner || !repo) return empty;

  const cfg = data ? getGitProviderConfigFor(data) : getGitProviderConfig();
  const token = await resolveGitToken(cfg).catch(() => null);
  if (!token) return empty;
  const branch = projectBaseBranch(data);

  // Newest run on the deploy branch (Gitea ≥1.24 and GitHub share this shape).
  const runs = await githubFetch(token, `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&limit=1&per_page=1`, undefined, cfg).catch(() => null);
  const run = runs?.workflow_runs?.[0];
  if (!run?.id) return empty;
  const jobsBody = await githubFetch(token, `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?limit=50&per_page=50`, undefined, cfg).catch(() => null);
  const jobs: any[] = Array.isArray(jobsBody?.jobs) ? jobsBody.jobs : [];
  if (!jobs.length) {
    return { ...empty, found: true, runNumber: run.run_number, state: normalize(run.status, run.conclusion), title: run.display_title, url: run.html_url || run.url };
  }
  const job = jobs.find((j) => normalize(j.status, j.conclusion) === 'failure') || jobs[jobs.length - 1];
  const raw = await githubFetch(token, `/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`, { headers: { Accept: 'text/plain' } }, cfg).catch(() => '');
  const text = typeof raw === 'string' ? raw : '';
  return {
    found: true,
    runNumber: typeof run.run_number === 'number' ? run.run_number : undefined,
    state: normalize(run.status, run.conclusion),
    job: typeof job.name === 'string' ? job.name : undefined,
    title: typeof run.display_title === 'string' ? run.display_title : undefined,
    sha: typeof run.head_sha === 'string' ? run.head_sha.slice(0, 7) : undefined,
    url: typeof run.html_url === 'string' ? run.html_url : undefined,
    ...summarize(cleanLog(text)),
  };
}
