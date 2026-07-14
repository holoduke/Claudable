// Child-process helpers: spawn-with-logging, dev-server readiness probe, process-tree kill.
import { spawn, type ChildProcess } from 'child_process';

/**
 * Kill the dev server AND its children. The dev server is a tree
 * (run-dev.js -> npm -> sh -> nuxt); killing only the parent left the nuxt
 * child alive holding the port, leaking a server on every restart. The child
 * is spawned detached, so a negative PID signals the whole process group.
 */
export function killProcessTree(child: ChildProcess | null | undefined): void {
  const pid = child?.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      child!.kill('SIGTERM');
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
      // Hard-stop the group shortly after if anything lingers.
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 4000).unref?.();
    } catch {
      child!.kill('SIGTERM');
    }
  } catch {
    /* already exited */
  }
}

export async function waitForPreviewReady(
  url: string,
  log: (chunk: Buffer | string) => void,
  timeoutMs = 60_000, // generous so a cold Angular/Next first build isn't cut off
  intervalMs = 1_000
) {
  const start = Date.now();
  let attempts = 0;

  // Per-attempt timeout so a hung connection can't block the readiness loop
  // beyond the overall budget.
  const fetchWithTimeout = (input: string, init?: RequestInit) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.min(intervalMs * 2, 5000));
    return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(t));
  };

  while (Date.now() - start < timeoutMs) {
    attempts += 1;
    try {
      const response = await fetchWithTimeout(url, { method: 'HEAD' });
      if (response.ok) {
        log(
          Buffer.from(
            `[PreviewManager] Preview server responded after ${attempts} attempt(s).`
          )
        );
        return true;
      }
      if (response.status === 405 || response.status === 501) {
        const getResponse = await fetchWithTimeout(url, { method: 'GET' });
        if (getResponse.ok) {
          log(
            Buffer.from(
              `[PreviewManager] Preview server responded to GET after ${attempts} attempt(s).`
            )
          );
          return true;
        }
      }
    } catch {
      // The dev server prints "Starting…" immediately but isn't listening until
      // it finishes its first compile, so early polls are EXPECTED to fail. Log a
      // clear "still starting" note once (not the raw fetch error, which reads
      // like a real failure) — a genuine timeout is reported after the loop.
      if (attempts === 1) {
        log(
          Buffer.from(
            `[PreviewManager] Preview server at ${url} not up yet — waiting for the dev server to finish compiling…`
          )
        );
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  log(
    Buffer.from(
      `[PreviewManager] Preview server did not respond within ${timeoutMs}ms; continuing regardless.`
    )
  );
  return false;
}

// Upper bound on a setup subprocess (install / docker build / predev). Without
// it, a stalled npm registry, a hung base-image pull, or a wedged predev makes
// startInternal never resolve — so the `.finally` that frees the reserved
// preview port never runs, the project is stuck "starting" forever, and the port
// leaks. On timeout we kill the whole process tree and reject so the caller's
// teardown (committed=false) releases the port.
const DEFAULT_COMMAND_TIMEOUT_MS = Number(process.env.PREVIEW_COMMAND_TIMEOUT_MS || 600_000);

export async function appendCommandLogs(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logger: (chunk: Buffer | string) => void,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      killProcessTree(child);
      logger(Buffer.from(`\n[PreviewManager] ${command} ${args.join(' ')} timed out after ${timeoutMs}ms — killed.\n`));
      finish(() => reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout?.on('data', logger);
    child.stderr?.on('data', logger);

    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      });
    });
  });
}
