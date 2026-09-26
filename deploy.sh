#!/bin/bash
# Robust, coalescing single-path deploy for Claudable.
# - flock: only ever one deploy runs at a time.
# - coalescing: a trigger that arrives while a deploy runs is NOT dropped; it
#   sets a pending flag, and the active deploy loops again afterwards. The
#   holder also re-checks origin/main after each build, so the final deployed
#   state always matches the newest pushed commit regardless of trigger timing.
# - fast: CACHED build by default (Docker layer cache — the heavy base layers
#   [apt, chrome-headless-shell, Go, PHP, docker CLI, npm deps] are reused unless
#   the Dockerfile / package-lock changes; only `COPY . . && next build` reruns on
#   a source change, so a typical deploy is ~1-2 min instead of ~10). Run
#   `NO_CACHE=1 ./deploy.sh` to force a clean, base-image-refreshing rebuild
#   (e.g. to pull a newer claude-code CLI / base image). --force-recreate always
#   swaps in the freshly-built image.
set -euo pipefail
export DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1
BUILD_ARGS=""
if [ "${NO_CACHE:-}" = "1" ]; then BUILD_ARGS="--no-cache --pull"; fi
PENDING=/tmp/claudable-deploy.pending
BUILD_LOGS=/opt/claudable/webhook/builds
exec 9>/tmp/claudable-deploy.lock
if ! flock -n 9; then
  # A deploy is already running. Ask it to run once more when it finishes
  # instead of silently dropping this request.
  touch "$PENDING"
  echo "$(date -u +%FT%TZ) deploy already running; queued a follow-up run"
  exit 0
fi
cd /opt/claudable
log(){ echo "$(date -u +%FT%TZ) $*"; }
while :; do
  rm -f "$PENDING"
  log "fetch+reset origin/main"
  git fetch origin main --quiet
  git reset --hard origin/main --quiet
  HEAD=$(git rev-parse --short HEAD)
  log "building+recreating ($HEAD)${BUILD_ARGS:+ [$BUILD_ARGS]}"
  # Full build output (incl. the test gate) goes to its own file; the poll log
  # keeps only these summary lines. The last 10 build logs are kept.
  mkdir -p "$BUILD_LOGS"
  BUILD_LOG="$BUILD_LOGS/$(date -u +%Y%m%dT%H%M%SZ)-$HEAD.log"
  if ! docker compose build $BUILD_ARGS >"$BUILD_LOG" 2>&1; then
    log "BUILD FAILED ($HEAD) — current version stays live. Tail of $BUILD_LOG:"
    tail -n 40 "$BUILD_LOG"
    ls -1t "$BUILD_LOGS"/*.log 2>/dev/null | tail -n +11 | xargs -r rm -f
    exit 1
  fi
  ls -1t "$BUILD_LOGS"/*.log 2>/dev/null | tail -n +11 | xargs -r rm -f
  docker compose up -d --force-recreate --remove-orphans
  docker image prune -f >/dev/null 2>&1 || true
  log "deployed $HEAD; waiting for health"
  # The container's own healthcheck (not an HTTP 200 on / — with auth on, / is a
  # redirect, so that probe never passed and always burned its full minute).
  health=unknown
  for i in $(seq 1 60); do
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' claudable 2>/dev/null || echo missing)
    case "$health" in healthy|none) break ;; unhealthy) break ;; esac
    sleep 2
  done
  log "health: $health ($HEAD)"
  # Re-check: if origin advanced during the build, or another trigger arrived,
  # loop and rebuild so we never leave a newer commit undeployed.
  git fetch origin main --quiet
  NEW=$(git rev-parse --short origin/main)
  if [ -f "$PENDING" ] || [ "$NEW" != "$HEAD" ]; then
    log "origin advanced ($HEAD -> $NEW) or follow-up queued; rebuilding"
    continue
  fi
  log "done ($HEAD)"
  break
done
