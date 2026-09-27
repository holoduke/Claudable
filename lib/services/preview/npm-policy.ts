// npm install-script policy for the isolated preview containers.
//
// npm 11 already warns "install scripts not yet covered by allowScripts" and is
// about to BLOCK dependency install scripts by default. Packages that genuinely
// need theirs (native binaries, platform setup) would then silently break a
// preview. This allowlist — delivered as a read-only user npmrc, so no project's
// package.json changes — keeps those working and quiet; any OTHER package with
// an install script still shows up in the log (and will be blocked once npm
// flips the default), which is exactly the signal worth keeping.
import fs from 'fs/promises';
import path from 'path';

export const NPM_ALLOW_SCRIPTS = [
  // native binaries / platform setup
  'esbuild', 'sharp', '@parcel/watcher', '@swc/core', '@tailwindcss/oxide', 'lightningcss',
  'better-sqlite3', 'sqlite3', 'bcrypt', 'argon2', 'canvas', 'msgpackr-extract', 'lmdb', 'unrs-resolver',
  'protobufjs', '@biomejs/biome',
  // runtime/tooling setup
  'vue-demi', 'core-js', 'puppeteer', 'cypress', 'electron', 'electron-winstaller', '@anthropic-ai/claude-code',
];

/** Contents of the npmrc handed to the preview containers (NPM_CONFIG_USERCONFIG). */
export function npmPolicyRc(): string {
  return `# Claudable preview policy (lib/services/preview/npm-policy.ts)\nallow-scripts=${NPM_ALLOW_SCRIPTS.join(',')}\n`;
}

/** Write the policy under the data dir (only when it changed); returns its path. */
export async function ensureNpmPolicyFile(dataRoot: string): Promise<string> {
  const file = path.join(dataRoot, '.npm-policy', 'npmrc');
  const want = npmPolicyRc();
  const have = await fs.readFile(file, 'utf8').catch(() => null);
  if (have !== want) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, want);
    await fs.rename(`${file}.tmp`, file);
  }
  return file;
}
