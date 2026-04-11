# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g npm@11.6.2

FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts

FROM deps AS builder
ENV NODE_ENV=production \
  DATABASE_URL=file:/app/data/cc.db \
  PROJECTS_DIR=/app/data/projects \
  ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  NEXT_PUBLIC_APP_URL=http://localhost:3000
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PRISMA_HIDE_UPDATE_MESSAGE=1 \
  NPM_CONFIG_UPDATE_NOTIFIER=false \
  PORT=3000 \
  WEB_PORT=3000 \
  HOSTNAME=0.0.0.0 \
  DATABASE_URL=file:/app/data/cc.db \
  PROJECTS_DIR=/app/data/projects \
  NEXT_PUBLIC_APP_URL=http://localhost:3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl git \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

RUN mkdir -p /app/data/projects /app/prisma/data \
  && chown -R node:node /app

USER node
EXPOSE 3000

CMD ["sh", "-c", ": \"${ENCRYPTION_KEY:?Set ENCRYPTION_KEY to a stable 64-character hex value before starting the container}\" && mkdir -p /app/data/projects && npx prisma db push --skip-generate && node server.js"]
