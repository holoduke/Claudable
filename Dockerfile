# Claudable — self-hosted AI web builder, running the agent via `claude -p`
# (Claude Code CLI / Agent SDK) with subscription auth (CLAUDE_CODE_OAUTH_TOKEN).
FROM node:22-bookworm-slim

# Tooling the agent needs at runtime: git (push to Gitea), ripgrep (claude search),
# ca-certificates, and a non-root user is avoided so generated previews can bind freely.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI on PATH so the Agent SDK can spawn `claude` headless.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install deps (cached on lockfile) and generate Prisma client.
# --ignore-scripts skips the desktop/electron postinstall and the dev-only
# ensure:env bootstrap (env is provided at runtime via compose env_file).
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma
RUN npx prisma generate

# Build the Next.js app.
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3700
ENV WEB_PORT=3700

# Ensure the SQLite schema exists on the mounted volume, then start.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx next start -p ${WEB_PORT}"]
