# Docker Runtime Spec

# Source

- Issues: https://github.com/opactorai/Claudable/issues/55 and https://github.com/opactorai/Claudable/issues/24
- Docker Next.js guide: https://docs.docker.com/guides/nextjs/containerize/

# Problem

Users want easier onboarding and better isolation.

The current repo has no Dockerfile or compose file.

# Current Code Fit

Claudable already has:

- Next.js `output: 'standalone'`
- local SQLite database in `data/cc.db`
- generated project workspaces in `data/projects`
- env bootstrap through `scripts/setup-env.js`
- web-only runtime through `npm run dev` / `next start`

Docker can target the web runtime. Electron packaging is out of scope.

# Proposed Behavior

Add Docker support for running the web app.

Deliverables:

```text
Dockerfile
.dockerignore
docker-compose.yml
README.md Docker section
```

# Runtime Model

Use a multi-stage Node image:

1. `deps`: install npm dependencies
2. `builder`: run Prisma generate and Next build
3. `runner`: copy standalone output, static assets, Prisma files, and scripts needed at runtime

Expose:

```text
3000
```

Persist:

```text
./data:/app/data
```

# Required Environment

```text
DATABASE_URL=file:/app/data/cc.db
PROJECTS_DIR=/app/data/projects
ENCRYPTION_KEY=<32-byte hex key>
NEXT_PUBLIC_APP_URL=http://localhost:3000
PORT=3000
WEB_PORT=3000
```

# CLI Agent Caveat

The hardest part is not Next.js. It is agent CLI availability.

Claude, Codex, Cursor, Qwen, GLM, OpenCode, and Droid may need:

- installed CLI binaries inside the image
- login/auth state
- API keys
- writable project volume
- git inside the container

First version should document this clearly.

# Compose Design

Use a single service:

```yaml
services:
  claudable:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
```

# Security

Do not bake secrets into the image.

Use env vars or mounted config volumes for CLI auth.

Generated apps run inside the same container in v1. This improves host isolation but is not a full sandbox.

# Risks

- `postinstall` runs `setup-env.js`, which writes `.env` and initializes `data`.
- Prisma SQLite path must be correct inside the container.
- Standalone output may need static and public directories copied.
- CLI auth persistence can be confusing.
- Running agents inside Docker needs enough tools installed for generated apps.

# First Version Scope

Implement:

- production web container
- persistent `data` volume
- README instructions
- clear limitation note for CLI login/auth

Defer:

- separate agent-runner container
- per-project sandbox containers
- GHCR publishing workflow
- Electron in Docker

# Tests

Minimum tests:

- `docker build .`
- `docker compose up`
- home page loads on `localhost:3000`
- `data/cc.db` persists after restart
- project directory persists under `data/projects`
- `npm run build` still works outside Docker

# Implementation Estimate

Medium.

Web runtime is straightforward. Full agent sandboxing is a larger project and should not be bundled into the first Docker patch.

