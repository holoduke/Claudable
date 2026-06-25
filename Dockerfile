# Claudable — self-hosted AI web builder, running the agent via `claude -p`
# (Claude Code CLI / Agent SDK) with subscription auth (CLAUDE_CODE_OAUTH_TOKEN).
FROM node:22-bookworm-slim

# Tooling the agent needs at runtime: git (push), ripgrep (claude search), ca-certs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI on PATH so the Agent SDK can spawn `claude` headless.
RUN npm install -g @anthropic-ai/claude-code

# Run as the non-root `node` user (uid 1000, matches the host volume owner) — Claude
# Code refuses --dangerously-skip-permissions as root. Building entirely as `node`
# (with COPY --chown) means files are created node-owned, so NO slow recursive chown.
WORKDIR /app
RUN chown node:node /app
USER node

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
