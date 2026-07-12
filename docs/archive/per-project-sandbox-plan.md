# Per-Project Sandbox — Design & Plan

**Status:** proposal (not started) · **Author:** it-ops/Claude · **Date:** 2026-06-30

## Goal
Run each project's agent (and its preview dev-server) inside its **own container**, so
that cross-project isolation is a **kernel boundary**, not a heuristic. Inside its own
container the agent has *full freedom* (root, shell, network, whole FS) — but that FS
contains **only that project**. "No leaks to other projects" becomes physically true.

## Non-goals
- Restricting what the agent can do *inside* its own sandbox (the opposite — we remove
  the in-process guard hook there).
- Changing the generated-app deploy path (Gitea Actions → host compose) — unchanged.
- microVM/gVisor in v1 (documented as an upgrade path, not the first target).

## Current state (what we're replacing)
- `lib/services/cli/claude.ts › executeClaude()` calls the Agent SDK `query()`
  **in-process** in the single `claudable` container (`permissionMode: 'bypassPermissions'`),
  streaming messages back to the UI over the existing channel.
- Isolation today = **env scrub** (`buildAgentEnv` allowlist) + a **heuristic `PreToolUse`
  guard** (`buildProjectGuardHook`) that denies cross-project paths. Acknowledged gap:
  doesn't catch base64/obfuscation or some bare `../` bash traversal.
- The **it-ops broker** is an in-process SDK MCP server (`buildItopsMcpServer`) — works
  *because* it's in-process: creds never enter the agent env.
- **Preview dev-servers** spawn in-process via `child_process.spawn` (npm/pnpm dev) on
  host ports 3710–3719, `network_mode: host`.

## Target architecture
```
Claudable orchestrator (main container — holds DB + all secrets)
  │  per agent turn / per project:
  ├─ spawn  sandbox-<projectId>   (its own container)
  │     ├─ claude -p  (the agent, via the SDK inside the container)
  │     ├─ /workspace        = ONLY data/projects/<projectId>  (its own volume)
  │     ├─ env: PATH/HOME + only this project's CLAUDE_CODE_OAUTH_TOKEN
  │     ├─ own bridge network (NOT host); no docker.sock; userns-remapped; caps dropped
  │     └─ mcpServers.itops → http://orchestrator:<port>/mcp  (broker stays OUT of the box)
  └─ preview dev-server runs in the SAME sandbox; Traefik route written by the broker
```
Other projects aren't in the sandbox's mount namespace, so they cannot be read at all.

## Key design decisions

### 1. Isolation level (v1 = Docker; upgrade path documented)
- **v1: Docker container per project** — userns-remap + `--cap-drop=ALL` (add back only
  what's needed) + no `docker.sock` + own network. Blocks accidental *and* prompt-injected
  cross-project access. Shares host kernel.
- **v2 (optional): gVisor `runsc`** — shrinks kernel attack surface, ~drop-in runtime.
- **v3 (optional): Firecracker/Kata microVM** — separate kernel = absolute isolation;
  needs `/dev/kvm` (bare-metal or nested-virt EC2). Pick only if the threat model includes
  kernel 0-days.

### 2. Agent runner: out-of-process
`executeClaude()` becomes a thin orchestrator that `docker run`s the sandbox image and
relays the SDK message stream. Two viable transports:
- **A. SDK-in-sandbox (preferred):** the sandbox image bundles the Agent SDK + `claude`
  CLI; a tiny runner script inside runs `query()` and emits NDJSON messages on stdout;
  the orchestrator reads the stream (same message types `executeClaude` already handles)
  and feeds the existing UI pipeline. Minimal change to the streaming/translation code.
- **B. SDK-in-orchestrator pointing at a remote CLI:** more coupling, rejected for v1.

Session resume: today `resume: sessionId` + transcripts persisted under
`claude-sessions`. Mount a **per-project** slice of that volume into the sandbox so
resume still works; the sandbox is ephemeral but its session dir is persistent.

### 3. The it-ops broker stays in the orchestrator
The broker must NOT move into the sandbox (that would put creds next to the agent).
Expose `buildItopsMcpServer()` as a **streamable-HTTP MCP server** on the orchestrator,
bound to the sandbox network only. The sandbox's `mcpServers.itops` points at it, with a
**per-sandbox bearer token** = (projectId, turnId) so the broker can scope + audit by
project. Creds (`COOLIFY_API_TOKEN`/`GIT_TOKEN`) never enter the sandbox. Same guarantee,
network-mediated instead of in-process.

### 4. Credentials into the sandbox
Only `CLAUDE_CODE_OAUTH_TOKEN` (the project's assigned credential — already built via
per-project credentials) + runtime basics. Nothing else. The env allowlist shrinks
further because the sandbox starts from an empty env, not Claudable's.

### 5. Networking
- Sandbox on its **own bridge network**, not `network_mode: host` (host networking is the
  opposite of isolated and is the current model).
- Preview server binds inside the sandbox; **Traefik route** (now writable by the broker)
  points the preview subdomain at the sandbox's address. Optional egress policy per
  sandbox (allow npm registry + API, deny lateral) if you want network-leak closure too.

### 6. Lifecycle
- **Spawn model:** per-turn (cold, simplest, ~1–2 s start) vs per-project warm-pool (keep
  N idle sandboxes hot for latency). Start per-turn; add warm-pool if latency hurts.
- Teardown after each turn; **orphan reaper** (label `claudable.sandbox=<projectId>`,
  sweep on a timer) for crash cleanup.
- **cgroup limits** per sandbox (CPU/mem/pids/disk-quota on the volume).
- Image build + layer cache so per-stack deps (Next/Nuxt/Angular) don't reinstall each
  turn; bake common deps into the sandbox image.

### 7. Docker-out-of-docker (the privilege to manage carefully)
The orchestrator must launch containers. Don't hand raw `docker.sock` to app code:
- Prefer a **rootless dockerd** dedicated to sandboxes, or
- A thin **spawn-API sidecar** exposing only `run/stop/logs` for `claudable.sandbox=*`
  images — the orchestrator can't drive arbitrary Docker.

## Phased rollout
| Phase | Deliverable | Proves |
|---|---|---|
| **0. Spike** | One hard-coded project → its own container; agent runs one turn; stream relayed; broker reachable over socket; teardown clean. Measure per-turn latency. | Feasibility + latency budget |
| **1. Runner** | `executeClaude()` refactor → sandbox runner (transport A), session-resume volume, env minimal. Behind a `SANDBOX_MODE` flag; in-process path stays as fallback. | Functional parity |
| **2. Broker-over-MCP** | Broker as HTTP MCP on the orchestrator + per-sandbox token + per-project audit/scope. | Security model preserved |
| **3. Network + preview** | Own bridge net per sandbox; preview server in-sandbox; Traefik route via broker. | No network leaks; preview works |
| **4. Lifecycle hardening** | userns-remap, cap-drop, cgroup limits, orphan reaper, image cache, rootless/ spawn-API. | Production-safe |
| **5. Cutover** | Flip default to sandbox mode; **drop the heuristic guard hook** (boundary now real); keep env scrub as defense-in-depth. | Simpler + stronger |
| **6. (opt) gVisor/microVM** | Swap runtime for VM-grade isolation. | "Absolutely no leaks" |

## Risks & mitigations
- **Per-turn latency** (cold start + dep install) → bake deps into image; warm-pool; keep
  the session volume so installs persist across turns.
- **DooD privilege** → rootless dockerd or spawn-API sidecar, never raw socket.
- **Kernel-shared isolation** → containers stop practical/injected leaks; gVisor/microVM
  for kernel-grade (phase 6).
- **Broker reachability coupling** → if the MCP endpoint is down, it-ops tools fail
  closed (agent keeps working without them); health-check + retry.
- **Resource sprawl** → cgroup caps + reaper + max-concurrent-sandboxes.
- **Migration risk** → `SANDBOX_MODE` flag + in-process fallback through phases 1–4;
  cutover only after parity.

## Decisions needed before Phase 1
1. **Spawn model:** per-turn cold vs warm-pool (latency vs idle cost)?
2. **Isolation target for v1:** plain Docker now, gVisor later — confirm?
3. **DooD mechanism:** rootless dockerd vs spawn-API sidecar?
4. **Scope of "no leaks":** filesystem+process only, or also **network egress** policy?
5. **Box capacity:** stay on box1, or is this the trigger to provision box2 (the
   provisioning bundle is ready) as the dedicated sandbox host?

## Rough effort
Spike: ~0.5–1 day. Phases 1–3 (functional + secure + preview): the bulk — a few focused
days. Phases 4–5 (hardening + cutover): another few days. gVisor/microVM: separate track.
```
```
