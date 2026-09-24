#!/usr/bin/env node
// Reports versions in lib/config/stack-versions.json (what new projects are scaffolded
// with) that are behind the latest release: npm majors, pip versions, Node LTS, Go and
// Python. Exit code 1 when something is behind, so it can gate CI or a scheduled job.
// Usage: npm run check:stack-versions
import fs from 'node:fs';

const file = new URL('../lib/config/stack-versions.json', import.meta.url);
const versions = JSON.parse(fs.readFileSync(file, 'utf8'));
const held = versions.held ?? {};

const major = (v) => Number(String(v).replace(/^[^\d]*/, '').split('.')[0]);
const minorOf = (v) => String(v).replace(/^[^\d]*/, '').split('.').slice(0, 2).join('.');
// For 0.x packages the minor is the breaking part.
const line = (v) => (major(v) === 0 ? minorOf(v) : String(major(v)));

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const behind = [];
const report = (name, current, latest, note) =>
  behind.push(`${name}: ${current} -> ${latest}${note ? `  (held: ${note})` : ''}`);

async function checkNpm() {
  await Promise.all(Object.entries(versions.npm).map(async ([name, range]) => {
    const { version } = await json(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`);
    if (name === '@types/node') {
      if (major(range) !== versions.node.major) report(name, range, `^${versions.node.major}.0.0 (node.major)`);
      return;
    }
    if (line(version) !== line(range)) report(`npm ${name}`, range, version, held[name]);
  }));
}

async function checkPip() {
  await Promise.all(Object.entries(versions.pip ?? {}).map(async ([name, pinned]) => {
    const { info } = await json(`https://pypi.org/pypi/${name.replace(/\[.*\]$/, '')}/json`);
    if (info.version !== pinned) report(`pip ${name}`, pinned, info.version, held[name]);
  }));
}

async function checkRuntimes() {
  const node = await json('https://nodejs.org/dist/index.json');
  const newestLts = node.find((release) => release.lts);
  if (major(newestLts.version) !== versions.node.major) report('node (LTS)', versions.node.major, newestLts.version);

  const go = await json('https://go.dev/dl/?mode=json');
  const goLatest = minorOf(go[0].version.replace(/^go/, ''));
  if (goLatest !== versions.go.version) report('go', versions.go.version, goLatest);

  const python = await json('https://endoflife.date/api/python.json');
  const pyImage = versions.python.image.match(/python:(\d+\.\d+)/)?.[1];
  if (pyImage && python[0].cycle !== pyImage) report('python', pyImage, python[0].cycle);
}

const results = await Promise.allSettled([checkNpm(), checkPip(), checkRuntimes()]);
const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);

if (errors.length) console.error(`Could not check everything:\n  ${errors.join('\n  ')}`);
if (behind.length) {
  console.log(`Behind the latest release (update lib/config/stack-versions.json and the root Dockerfile):\n  ${behind.sort().join('\n  ')}`);
} else if (!errors.length) {
  console.log('All scaffold stack versions are current.');
}
process.exit(behind.some((b) => !b.includes('(held:')) || errors.length ? 1 : 0);
