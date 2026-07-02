# Claudable — self-hosted AI web builder, running the agent via `claude -p`
# (Claude Code CLI / Agent SDK) with subscription auth (CLAUDE_CODE_OAUTH_TOKEN).
FROM node:22-bookworm-slim

# Tooling the agent needs at runtime: git (push), ripgrep (claude search), ca-certs.
# chromium + fonts-liberation power server-side project thumbnails (headless capture).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# Path to the headless browser used for thumbnail capture (lib/services/thumbnail.ts).
ENV CHROMIUM_PATH=/usr/bin/chromium

# Go toolchain — lets the preview build+run a project's Go backend (the `static`
# import mode's backend sidecar). Pinned; copied from the official image.
COPY --from=golang:1.25-bookworm /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" \
    GOTOOLCHAIN=local \
    GOFLAGS=-buildvcs=false

# Docker CLI ONLY (not the daemon) — for project-environment isolation, Claudable
# builds/runs hardened sibling containers via the socket-proxy (DOCKER_HOST). Just
# the static client binary; talks to a remote daemon, runs nothing locally.
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
  && docker --version

# Claude Code CLI on PATH so the Agent SDK can spawn `claude` headless.
RUN npm install -g @anthropic-ai/claude-code

# Run as the non-root `node` user (uid 1000, matches the host volume owner) — Claude
# Code refuses --dangerously-skip-permissions as root. Building entirely as `node`
# (with COPY --chown) means files are created node-owned, so NO slow recursive chown.
WORKDIR /app
RUN chown node:node /app
USER node

# Pre-create ~/.claude as node so a bind-mount at ~/.claude/skills doesn't make
# Docker create the parent as root (which blocks the agent writing session-env).
RUN mkdir -p /home/node/.claude

# Install deps (cached on lockfile). --ignore-scripts skips electron/postinstall.
COPY --chown=node:node package*.json ./
RUN npm ci --ignore-scripts
COPY --chown=node:node prisma ./prisma
RUN npx prisma generate

# Build the Next.js app.
COPY --chown=node:node . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3700
ENV WEB_PORT=3700

# Ensure the SQLite schema exists on the mounted volume, then start.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx next start -p ${WEB_PORT}"]
