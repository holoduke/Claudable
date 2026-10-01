import { describe, expect, it } from 'vitest';
import { toAgentContainerPaths } from './container-paths';

const ROOT = '/app/data/projects/p1';

describe('toAgentContainerPaths', () => {
  it('maps attachment paths into /work', () => {
    expect(toAgentContainerPaths(`What is this?\n\nImage #1 path: ${ROOT}/assets/a.png`, ROOT)).toBe('What is this?\n\nImage #1 path: /work/assets/a.png');
  });
  it('maps every occurrence and the bare root, tolerating a trailing slash', () => {
    expect(toAgentContainerPaths(`${ROOT}/a and ${ROOT}/b in ${ROOT}`, `${ROOT}/`)).toBe('/work/a and /work/b in /work');
  });
  it('leaves other projects and unrelated paths alone', () => {
    const text = 'see /app/data/projects/p10/x and /etc/hosts and assets/y.zip';
    expect(toAgentContainerPaths(text, ROOT)).toBe(text);
  });
});
