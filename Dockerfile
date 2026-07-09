# Claudable — self-hosted AI web builder, running the agent via `claude -p`
# (Claude Code CLI / Agent SDK) with subscription auth (CLAUDE_CODE_OAUTH_TOKEN).
FROM node:22-bookworm-slim

# Tooling the agent needs at runtime: git (push), ripgrep (claude search), ca-certs.
# The lib list is chrome-headless-shell's runtime deps (thumbnails + PDF export).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl unzip fonts-liberation \
     libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
     libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
  && rm -rf /var/lib/apt/lists/*

# PINNED headless browser (Chrome for Testing "chrome-headless-shell") for
# thumbnails + PDF export. Debian's `chromium` package is a moving target — its
# 150.x build SIGTRAPs on any headless run in this container, which silently
# broke thumbnail capture and the PDF exporter. A versioned Google build keeps
# rebuilds deterministic; bump the version deliberately, testing headless runs.
ARG CHROME_HEADLESS_VERSION=141.0.7390.65
RUN curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_HEADLESS_VERSION}/linux64/chrome-headless-shell-linux64.zip" -o /tmp/chs.zip \
  && unzip -q /tmp/chs.zip -d /opt \
  && mv /opt/chrome-headless-shell-linux64 /opt/chrome-headless-shell \
  && rm /tmp/chs.zip \
  && /opt/chrome-headless-shell/chrome-headless-shell --version

# Path to the headless browser used by thumbnail capture + PDF export.
ENV CHROMIUM_PATH=/opt/chrome-headless-shell/chrome-headless-shell

# Go toolchain — lets the preview build+run a project's Go backend (the `static`
# import mode's backend sidecar). Pinned; copied from the official image.
COPY --from=golang:1.25-bookworm /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" \
    GOTOOLCHAIN=local \
    GOFLAGS=-buildvcs=false

# PHP 8.3 toolchain + Composer — lets the AGENT run Laravel/Filament generators
# (composer require, php artisan make:*, migrate) for the Filament (Laravel)
# stack, the same way the Go toolchain above lets it build Go backends. Pinned
# to 8.3 to match the preview image (webdevops/php:8.3) so composer platform
# checks agree. Extensions are the Laravel + Filament set. Via the sury repo
# (bookworm ships 8.2). The agent shares the project dir with the preview, so
# artisan/migrations it runs are what the running app serves.
RUN curl -fsSL https://packages.sury.org/php/apt.gpg -o /etc/apt/trusted.gpg.d/sury-php.gpg \
  && echo "deb https://packages.sury.org/php/ bookworm main" > /etc/apt/sources.list.d/sury-php.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
     php8.3-cli php8.3-intl php8.3-sqlite3 php8.3-mbstring php8.3-xml \
     php8.3-curl php8.3-zip php8.3-gd php8.3-bcmath \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer \
  && php -v | head -1 && composer --version

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

# Install deps (cached on lockfile). --ignore-scripts skips the postinstall
# env setup, so better-sqlite3 (Prisma driver adapter, native module) must be
# rebuilt explicitly — prebuild-install fetches the prebuilt binding.
COPY --chown=node:node package*.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

# Prisma 7 reads the datasource from prisma.config.ts (not schema.prisma) and
# resolves it eagerly, so build-time steps need a DATABASE_URL even though
# generate/build never open the database. The value mirrors the runtime env.
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node prisma.config.ts tsconfig.json ./
RUN DATABASE_URL="file:../data/cc.db" npx prisma generate

# Build the Next.js app.
COPY --chown=node:node . .
RUN DATABASE_URL="file:../data/cc.db" npm run build

ENV NODE_ENV=production
ENV PORT=3700
ENV WEB_PORT=3700

# Ensure the SQLite schema exists on the mounted volume, then start.
# (--skip-generate was removed in Prisma 7; the client is generated at build.)
CMD ["sh", "-c", "npx prisma db push && npx next start -p ${WEB_PORT}"]
