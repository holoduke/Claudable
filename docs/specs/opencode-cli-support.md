# OpenCode CLI Support Spec

# Source

- Issue: https://github.com/opactorai/Claudable/issues/69
- OpenCode CLI docs: https://opencode.ai/docs/cli/

# Problem

Users want to use OpenCode as another coding agent inside Claudable.

# Current Code Fit

Claudable already supports adapter-based CLIs:

- `lib/services/cli/codex.ts`
- `lib/services/cli/cursor.ts`
- `lib/services/cli/qwen.ts`
- `lib/services/cli/glm.ts`
- `lib/constants/*Models.ts`
- `types/cli.ts`
- `app/api/settings/cli-status/route.ts`
- `app/api/chat/[project_id]/act/route.ts`

OpenCode fits this model because its docs expose:

- non-interactive `opencode run`
- `--model`
- `--session`
- `--file`
- `--format json`

# Proposed Behavior

Add `opencode` as a first-class CLI option.

Run mode:

```text
opencode run --format json --model <provider/model> <prompt>
```

Optional:

```text
opencode run --session <sessionId> --format json --model <provider/model> <prompt>
```

# Files To Add

```text
lib/services/cli/opencode.ts
lib/constants/opencodeModels.ts
```

# Files To Update

```text
types/cli.ts
types/backend/cli.ts
lib/constants/cliModels.ts
lib/utils/cliOptions.ts
app/api/settings/cli-status/route.ts
app/api/chat/[project_id]/act/route.ts
components/modals/CreateProjectModal.tsx
public/
README.md
```

# Adapter Design

Follow `codex.ts` and `qwen.ts`.

Process:

1. Resolve project path under `PROJECTS_DIR`.
2. Prefer nested `repo/` folder only if present, matching current adapters.
3. Build a prompt with Claudable autonomous instructions.
4. Spawn `opencode`.
5. Parse JSON lines when `--format json` produces events.
6. Persist assistant messages and tool summaries.
7. Mark user request lifecycle as running/completed/failed.

Skeleton:

```ts
const OPENCODE_EXECUTABLE = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';

const args = [
  'run',
  '--format',
  'json',
  '--model',
  normalizedModel,
  promptWithContext,
];
```

# Model Strategy

OpenCode uses provider/model IDs.

Start with conservative defaults:

```text
anthropic/claude-sonnet-4-5
openai/gpt-5.4
openai/gpt-5.3-codex
google/gemini-3-pro
```

Exact availability depends on the user's OpenCode provider configuration. The settings UI should describe that model IDs must match OpenCode's configured providers.

# Status Check

Add:

```ts
opencode --version
```

Return configured status as installed if command exists. Deeper auth checks can come later with `opencode auth list`.

# Risks

- JSON event shape needs a real smoke test.
- Provider/model IDs depend on OpenCode config.
- Some OpenCode tools may require permission config.
- Session IDs are OpenCode-specific and need a new active session field if durable resume is desired.

# First Version Scope

Do not add durable session resume in v1.

Implement:

- run one-shot tasks
- stream/persist final text
- status detection
- model selection

Add session resume later after verifying event/session payloads.

# Tests

Minimum tests:

- status route includes `opencode`
- `act` route selects OpenCode executor
- missing binary returns clear message
- JSON parser handles malformed event lines
- final assistant message persists

# Implementation Estimate

Medium-high.

Adapter shape is clear. The unknown is exact OpenCode JSON output behavior across versions.

