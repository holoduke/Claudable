import { describe, expect, it } from 'vitest';
import { narrowContextPaths } from './build-context';

describe('narrowContextPaths', () => {
  it('collects literal COPY/ADD sources and ignores multi-stage copies', () => {
    const df = [
      'FROM golang:1.25-alpine AS build',
      'WORKDIR /src',
      'COPY backend/go.mod backend/go.sum ./',
      'RUN go mod download',
      'COPY backend/ ./',
      'RUN go build -o /out/server .',
      'FROM alpine',
      'COPY --from=build /out/server /app/server',
      'COPY --chown=app:app d/ /app/d/',
    ].join('\n');
    expect(narrowContextPaths(df)).toEqual(['backend', 'd']);
  });

  it('handles JSON form and line continuations', () => {
    expect(narrowContextPaths('FROM x\nCOPY ["api/main.go", "api/go.mod", "/src/"]\nADD \\\n  conf/app.toml \\\n  /etc/app.toml\n'))
      .toEqual(['api/go.mod', 'api/main.go', 'conf/app.toml']);
  });

  it('falls back (null) whenever the full context might be needed', () => {
    for (const bad of [
      'COPY . .',
      'COPY ./ /app',
      'COPY * /app/',
      'COPY src/*.go /app/',
      'COPY $SRC /app',
      'ADD https://example.com/x.tgz /x',
      'COPY ../secret /x',
      'COPY <<EOF /x\nhi\nEOF',
      'ONBUILD COPY app/ /app',
      'COPY --parents a/b /x',
      'COPY onlyone',
    ]) {
      expect(narrowContextPaths(`FROM x\n${bad}\n`), bad).toBeNull();
    }
  });

  it('ignores comments and needs no sources for a COPY-less Dockerfile', () => {
    expect(narrowContextPaths('# COPY . .\nFROM x\nRUN echo hi\n')).toEqual([]);
  });
});

describe('narrowBuildContext (filesystem)', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const { narrowBuildContext } = await import('./docker');
  const mk = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bctx-'));
    fs.mkdirSync(path.join(root, 'backend'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'backend', 'go.mod'), 'module x');
    fs.writeFileSync(path.join(root, 'backend', 'Dockerfile'), 'FROM x\nCOPY backend/go.mod ./\nCOPY backend/ ./\n');
    return root;
  };
  const cfg = { dockerfile: 'backend/Dockerfile', context: '.', port: 8080 } as any;

  it('narrows to the copied dirs and does not add a Dockerfile they already hold', async () => {
    const root = mk();
    expect(await narrowBuildContext(root, cfg)).toEqual({ contextDir: root, dockerfile: 'backend/Dockerfile', paths: ['backend'] });
  });

  it('adds the Dockerfile when it lives outside the copied paths', async () => {
    const root = mk();
    fs.mkdirSync(path.join(root, 'deploy'));
    fs.writeFileSync(path.join(root, 'deploy', 'Dockerfile.backend'), 'FROM x\nCOPY backend/ ./\n');
    expect((await narrowBuildContext(root, { ...cfg, dockerfile: 'deploy/Dockerfile.backend' }))?.paths)
      .toEqual(['deploy/Dockerfile.backend', 'backend']);
  });

  it('keeps the full context when the project has its own .dockerignore', async () => {
    const root = mk();
    fs.writeFileSync(path.join(root, '.dockerignore'), 'node_modules\n');
    expect(await narrowBuildContext(root, cfg)).toBeNull();
  });

  it('refuses when a copied path escapes through a symlinked parent dir', async () => {
    const root = mk();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bctx-out-'));
    fs.writeFileSync(path.join(outside, 'secret'), 's');
    fs.symlinkSync(outside, path.join(root, 'linked'));
    fs.writeFileSync(path.join(root, 'backend', 'Dockerfile'), 'FROM x\nCOPY linked/secret /s\n');
    expect(await narrowBuildContext(root, cfg)).toBeNull();
  });
});
