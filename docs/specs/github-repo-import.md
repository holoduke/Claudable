# Existing GitHub Repository Import Spec

# Source

- Issue: https://github.com/opactorai/Claudable/issues/64
- Related comment: users want to open an existing Lovable/GitHub repo and continue work in Claudable.

# Problem

Claudable currently optimizes for new project creation.

Users can create a local project and later connect or push it to GitHub, but there is no first-class flow for:

- entering an existing GitHub repo URL
- cloning it into `data/projects`
- creating a Claudable `Project` record around that checkout
- starting preview and continuing agent work from the cloned codebase

# Current Code Fit

The current architecture supports this well.

- `Project.repoPath` already points to a local workspace.
- `lib/services/project.ts` creates project directories.
- `lib/services/github.ts` already has GitHub token lookup and repo metadata fetch helpers.
- `lib/services/git.ts` wraps local git commands.
- `lib/services/preview.ts` already normalizes nested Next.js projects.
- `app/[project_id]/chat/page.tsx` and file-browser APIs already work from `repoPath`.

# Proposed Behavior

Add an "Import GitHub repo" flow from the project creation surface.

User flow:

1. User chooses "Import GitHub repo".
2. User enters a URL such as `https://github.com/org/repo`.
3. Optional: user provides branch name.
4. Server validates the repo.
5. Server clones the repo into `data/projects/<projectId>`.
6. Server creates the `Project` record with `repoPath`.
7. Server stores a GitHub service connection.
8. UI routes to the chat page.
9. Preview can be started the same way as generated projects.

# API Design

Add:

```text
POST /api/projects/import/github
```

Request:

```json
{
  "repo_url": "https://github.com/owner/repo",
  "branch": "main",
  "name": "repo",
  "preferredCli": "claude",
  "selectedModel": "claude-sonnet-4-6"
}
```

Response:

```json
{
  "success": true,
  "data": {
    "id": "project-id",
    "name": "repo",
    "repoPath": "/absolute/path/to/data/projects/project-id"
  }
}
```

# Service Design

Add a service function:

```ts
importGitHubRepository(input: ImportGitHubRepositoryInput): Promise<Project>
```

Implementation outline:

1. Parse and validate GitHub URL.
2. Resolve owner/repo.
3. If GitHub token exists, fetch metadata through `getGithubRepositoryDetails`.
4. Generate project ID.
5. Create target directory under `PROJECTS_DIR`.
6. Clone with `git clone --branch <branch> --single-branch <cloneUrl> <targetPath>`.
7. Use an authenticated HTTPS clone URL only for the clone process.
8. Reset origin remote to the clean public/private clone URL after clone.
9. Create the `Project` row.
10. Store `ProjectServiceConnection` for GitHub.

# Security

Do not store tokens in `.git/config`.

This repo already fixed push behavior to avoid writing GitHub tokens into remotes. Import should follow the same pattern:

- use authenticated URL only as a process argument during clone
- immediately set `origin` to the clean `https://github.com/owner/repo.git`
- never persist token in project settings or service data

# Edge Cases

- Repo URL invalid
- Repo does not exist
- Token missing for private repo
- Target project directory already exists
- Branch does not exist
- Repo is not a Next.js app
- Repo is a monorepo with nested app
- Clone is too slow or too large

# Tests

Minimum tests:

- URL parsing for HTTPS and SSH-like forms
- private repo clone uses token but stores clean origin
- invalid URL returns 400
- missing token for private repo returns clear 401/404 guidance
- imported project appears in project list
- preview starts when imported repo has a root Next.js package

# Implementation Estimate

Medium.

Most infrastructure already exists. The main work is clone orchestration, UI entry point, and error handling.

