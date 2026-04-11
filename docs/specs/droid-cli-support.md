# Droid CLI Support Spec

# Source

- Issue: https://github.com/opactorai/Claudable/issues/66
- Factory Droid CLI reference: https://docs.factory.ai/reference/cli-reference

# Problem

Users requested Droid CLI support.

# Current Code Fit

Droid fits the same adapter model as Codex, Cursor, and Qwen because it supports:

- non-interactive `droid exec`
- `--cwd`
- `--model`
- `--session-id`
- `--output-format stream-json`
- `--auto`

# Proposed Behavior

Add `droid` as a selectable CLI agent.

Execution command:

```text
droid exec --cwd <repoPath> --output-format stream-json --auto medium --model <model> <prompt>
```

For less risky first version:

```text
droid exec --cwd <repoPath> --output-format stream-json --auto low --model <model> <prompt>
```

# Files To Add

```text
lib/services/cli/droid.ts
lib/constants/droidModels.ts
```

# Files To Update

```text
types/cli.ts
types/backend/cli.ts
lib/constants/cliModels.ts
lib/utils/cliOptions.ts
app/api/settings/cli-status/route.ts
app/api/chat/[project_id]/act/route.ts
components/settings/GlobalSettings.tsx
components/modals/CreateProjectModal.tsx
README.md
```

# Auth

Droid uses Factory authentication.

Support these paths:

- user has already authenticated with `droid`
- user sets `FACTORY_API_KEY`
- user saves a Droid API key in global settings, which is injected into the spawned process environment

Do not require key storage in the first implementation if local `droid` login is enough.

# Model Strategy

Start with models documented in Factory's CLI reference:

```text
claude-opus-4-6
claude-opus-4-6-fast
claude-sonnet-4-6
gpt-5.4
gpt-5.3-codex
gpt-5.2
gemini-3.1-pro-preview
glm-4.7
glm-5
kimi-k2.5
minimax-m2.5
```

Use `claude-sonnet-4-6` as default.

# Autonomy

Do not use `--skip-permissions-unsafe` by default.

Factory docs mark it as unsafe and suited for isolated environments. Use `--auto low` or `--auto medium`.

Recommended default:

```text
--auto medium
```

Rationale:

- Claudable needs the agent to edit files and run local build commands.
- `medium` allows development work.
- It avoids skipping all guardrails.

# Risks

- Droid output event shape needs smoke testing.
- API key storage needs careful UX and token handling.
- Some operations may require higher autonomy than `medium`.
- Model IDs may change with Factory configuration.

# First Version Scope

Implement:

- status detection with `droid --version`
- one-shot execution through `droid exec`
- `stream-json` parsing
- basic model list
- optional `FACTORY_API_KEY` injection from settings

Defer:

- custom droids/subagents UI
- mission mode
- durable session management
- unsafe permission mode

# Tests

Minimum tests:

- status route includes `droid`
- missing binary gives clear install message
- env injection does not log API key
- `act` route maps `droid` to executor
- JSON parser handles partial or malformed events
- process close code maps to success/failure

# Implementation Estimate

Medium-high.

The CLI contract is better documented than many agent CLIs. The main risk is output event parsing.

