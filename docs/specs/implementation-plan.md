# Implementation Plan

# Goal

Turn the issue research into an implementable roadmap for Claudable.

This plan is based on the spec files in this directory.

# Priority 1: Existing GitHub Repo Import

Spec:

```text
docs/specs/github-repo-import.md
```

Why first:

- Strong product fit.
- Repeated user demand.
- Existing code already has most of the required data model and services.
- Low conceptual risk compared with new CLI integrations.

Implementation steps:

1. Add GitHub repo URL parser and tests.
2. Add `importGitHubRepository` service in `lib/services/github.ts` or a new `lib/services/repo-import.ts`.
3. Add safe clone helper in `lib/services/git.ts`.
4. Add `POST /api/projects/import/github`.
5. Add UI entry point in project creation flow.
6. Store GitHub service connection after import.
7. Start preview only after clone completes.
8. Add error messages for private repo, bad branch, invalid URL, and non-Next repo.

Acceptance:

- public repo can be imported
- private repo can be imported with configured GitHub token
- token is not written to `.git/config`
- imported project opens in the builder

# Priority 2: Claude Compact and Clear

Spec:

```text
docs/specs/context-compact-clear.md
```

Why second:

- Real repeated user pain.
- Official Claude SDK supports slash commands.
- Smaller scope if kept Claude-only.

Implementation steps:

1. Add `compactClaudeSession` and `clearClaudeSession`.
2. Add API routes under `app/api/chat/[project_id]/`.
3. Publish status events for start/success/failure.
4. Track `compact_boundary` events.
5. Add compact/clear controls in chat settings.
6. Detect context-limit errors and show compact guidance.
7. Add route-level tests or service-level tests if test harness is present.

Acceptance:

- `/compact` runs against active Claude session
- `/clear` starts a fresh Claude session
- UI does not show compact for unsupported CLIs
- context-limit errors have a clear recovery action

# Priority 3: OpenCode CLI Support

Spec:

```text
docs/specs/opencode-cli-support.md
```

Why third:

- The CLI has an official non-interactive `opencode run` command.
- JSON output mode exists.
- It is a better fit than direct Ollama.

Implementation steps:

1. Add OpenCode model constants.
2. Add `opencode` to CLI type unions and active CLI lists.
3. Add status check with `opencode --version`.
4. Add `lib/services/cli/opencode.ts`.
5. Wire `act/route.ts` executor dispatch.
6. Add create-project and settings UI support.
7. Smoke test JSON output locally.
8. Add docs for authentication and provider/model IDs.

Acceptance:

- installed OpenCode appears as available
- user can select OpenCode
- prompt runs against project workspace
- final assistant response is persisted and streamed

# Priority 4: Docker Web Runtime

Spec:

```text
docs/specs/docker-runtime.md
```

Why fourth:

- Good onboarding feature.
- Useful for isolation.
- But full agent auth and sandboxing require careful follow-up.

Implementation steps:

1. Add `.dockerignore`.
2. Add multi-stage `Dockerfile`.
3. Add `docker-compose.yml`.
4. Validate `DATABASE_URL` and `PROJECTS_DIR` inside container.
5. Document CLI auth limitations.
6. Build and run locally.
7. Add README section.

Acceptance:

- image builds
- app serves on port 3000
- SQLite DB persists on host volume
- project files persist on host volume

# Priority 5: Droid CLI Support

Spec:

```text
docs/specs/droid-cli-support.md
```

Why after OpenCode:

- Technically feasible.
- Official non-interactive mode exists.
- But auth and autonomy settings need more UX work.

Implementation steps:

1. Add Droid model constants.
2. Add CLI type and UI option.
3. Add status check with `droid --version`.
4. Add `lib/services/cli/droid.ts`.
5. Use `droid exec --cwd <repoPath> --output-format stream-json --auto medium`.
6. Add optional `FACTORY_API_KEY` support.
7. Parse stream JSON and persist messages.
8. Document setup and auth.

Acceptance:

- Droid appears in CLI settings
- one-shot project edits work
- API key is not logged
- failed auth produces a clear UI error

# Not Recommended Now

Ollama direct support:

- Do not implement as a direct agent yet.
- Prefer provider integration through OpenCode/Droid.

iFlow support:

- Do not implement.
- The upstream project has a shutdown notice.

# Cross-Cutting Work

Apply to every feature:

- keep tokens out of logs and git remotes
- use `PROJECTS_DIR` boundaries for all filesystem writes
- publish realtime status events for long-running work
- keep CLI-specific behavior in `lib/services/cli/*`
- avoid changing unrelated UI and dependency versions in the same patch

