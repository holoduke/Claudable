---
name: verify-changes
description: After building or changing a Claudable app, verify it actually works before saying you are done. Use whenever you finish an edit, add a feature, or fix a bug — check the running preview for errors and confirm the change is visible.
---

# Verify your changes in the running preview

Claudable runs the app you edit as a LIVE preview. A change is not done until you have confirmed the running app still works. Do this before telling the user you are finished.

## The loop
1. **Check runtime health** — call the `mcp__appdiag__check_app_health` tool. It returns the running preview's uncaught browser errors, console errors/warnings, and Nuxt/nitro backend (server) errors. An empty result is NOT proof of success — it only means nothing has been reported since the preview last started — so also reason about whether your change would actually render.
2. **Fix what you find** — if there are errors, make them the priority: read the offending file, fix the root cause, then re-check. Do not declare done while `check_app_health` shows errors related to your change.
3. **Confirm the change is real** — make sure the code you edited is on the route/page the user will look at, and that it compiles (no import/type errors in the backend logs).

## Rules
- Never say "done" or "I have added X" without checking health at least once after the final edit.
- If the preview is not running or reports nothing, say so honestly rather than implying you verified it.
- Prefer a small, reversible change you can verify over a large one you cannot.
- When an error is non-obvious, pair this with the `diagnosing-bugs` skill.
