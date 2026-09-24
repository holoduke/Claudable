// Typed access to stack-versions.json — the single place for the versions Claudable
// scaffolds (package.json of new projects, preview/deploy/backend images).
// scripts/check-stack-versions.mjs compares the same file against the registries.
import versions from './stack-versions.json';

export type ScaffoldPackage = keyof typeof versions.npm;

export const NODE_MAJOR = versions.node.major;
export const NODE_IMAGE = versions.node.image;
export const NODE_ALPINE_IMAGE = versions.node.alpineImage;
export const GO_VERSION = versions.go.version;
export const GO_IMAGE = versions.go.image;
export const PYTHON_IMAGE = versions.python.image;

/** requirements.txt lines (`name==version`) for the Python backend scaffold. */
export const PIP_REQUIREMENTS = Object.entries(versions.pip).map(([name, version]) => `${name}==${version}`);

/** `{ name: range }` for a package.json dependencies block, in the given order. */
export function npmDeps(...names: ScaffoldPackage[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, versions.npm[name]]));
}
