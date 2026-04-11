# Context Compact and Clear Spec

# Source

- Issues: https://github.com/opactorai/Claudable/issues/13 and https://github.com/opactorai/Claudable/issues/3
- Claude Code SDK docs: https://code.claude.com/docs/en/agent-sdk/slash-commands

# Problem

Long sessions can fail with context-limit errors.

Users report errors such as:

```text
input length and max_tokens exceed context limit
```

They also report that manual compacting in Claude Code can force a new session after restarting Claudable.

# Current Code Fit

Claudable already stores session state:

- `Project.activeClaudeSessionId`
- `Project.activeCursorSessionId`
- `Session`
- `Message`
- `Message.tokenCount`

Claude execution already resumes with:

```ts
resume: sessionId
```

The Claude Agent SDK supports sending slash commands through the prompt string. Official docs show `/compact` and `/clear` can be sent via `query(...)`, and `/compact` emits a `compact_boundary` system event.

# Proposed Behavior

Add Claude-only compact and clear actions first.

User flow:

1. User clicks "Compact context" in the chat page.
2. Server sends `/compact` into the active Claude session.
3. UI shows compact progress and final compact result.
4. Existing project stays open.
5. Future Claude runs continue with the compacted session.

Clear flow:

1. User clicks "Clear Claude session".
2. Server sends `/clear`.
3. Server updates `Project.activeClaudeSessionId` to the new returned session ID if available.
4. UI clearly indicates that a new Claude session started.

# API Design

Add:

```text
POST /api/chat/[project_id]/compact
POST /api/chat/[project_id]/clear
```

Compact request:

```json
{
  "instructions": "Preserve implementation decisions and current task state."
}
```

Clear request:

```json
{}
```

# Service Design

Add to `lib/services/cli/claude.ts`:

```ts
export async function compactClaudeSession(projectId: string, projectPath: string, instructions?: string): Promise<void>
export async function clearClaudeSession(projectId: string, projectPath: string): Promise<void>
```

Compact prompt:

```text
/compact <optional instructions>
```

Clear prompt:

```text
/clear
```

Options:

```ts
{
  workingDirectory: absoluteProjectPath,
  additionalDirectories: [absoluteProjectPath],
  resume: activeClaudeSessionId,
  maxTurns: 1
}
```

# Error Handling

Detect context-limit failures in Claude execution and publish a status event:

```text
Context limit reached. Compact the session and retry.
```

Do not auto-compact silently on the first version. It can change conversation state and should be user-visible.

# Cross-CLI Scope

Initial scope is Claude only.

Reason:

- Claude SDK has documented `/compact` and `/clear` behavior.
- Other CLI adapters have different session semantics.
- DB message deletion does not guarantee provider context reduction.

# UI Changes

Add a small chat settings action group:

- Compact context
- Clear Claude session

Disable or hide these for non-Claude CLIs until equivalent behavior is implemented.

# Tests

Minimum tests:

- route returns 404 for missing project
- route returns 400/409 when no active Claude session exists
- compact publishes a status event
- compact handles `compact_boundary`
- clear updates active session when SDK returns a new session ID
- non-Claude preferred CLI gets a clear "Claude only" response

# Implementation Estimate

Medium.

The backend path is clear. The risk is session state accuracy and UI messaging.

