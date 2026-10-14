import { describe, expect, it } from 'vitest';
import { pushRefusal } from './git';

describe('pushRefusal', () => {
  it('explains a GitHub App that may not touch workflow files', () => {
    const out = ' ! [remote rejected] HEAD -> claudable-publish (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)';
    expect(pushRefusal(out)).toMatch(/workflow files \(\.github\/workflows\/ci\.yml\)/);
  });

  it('names branch rules, missing access and oversized files', () => {
    expect(pushRefusal('remote: error: GH013: Repository rule violations found for refs/heads/main.')).toMatch(/branch rule/);
    expect(pushRefusal('remote: Permission to new-story/x.git denied to newstory-claudable[bot].')).toMatch(/no write access/);
    expect(pushRefusal('remote: error: GH001: Large files detected.')).toMatch(/larger than GitHub allows/);
  });

  it('leaves a plain non-fast-forward to the force-with-lease path', () => {
    expect(pushRefusal(' ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs')).toBeNull();
    expect(pushRefusal(' ! [rejected]        HEAD -> main (non-fast-forward)')).toBeNull();
  });
});
