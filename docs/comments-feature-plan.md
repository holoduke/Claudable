# Preview Comments — Design & Plan

**Status:** proposal (not started) · **Date:** 2026-07-01

## Goal
Let users pin **comments to specific spots on the previewed site**, visible **only in
Claudable** (never on the deployed app). Comments are **scoped per route** — each page
shows its own set. A **Comment** button (next to Edit) toggles comment mode; a **Clear
all** action wipes the current view's comments.

## Non-goals (v1)
- Real-time multi-user collaboration / presence cursors.
- Comments on the deployed/production site (these are a Claudable-only review layer).
- Threaded replies (start with single comments; replies are an easy follow-up).

## Building blocks we already have (reuse)
- **Preview bridge** (`lib/services/preview.ts` injected `claudable-preview.client.ts`):
  a preview-only, gitignored plugin that postMessages the parent. It already does the
  **route reporter** (`{source:'claudable-preview', path}`) and, from the visual editor,
  **hover/click/select + overlays** (`claudable-editor` / `claudable-editor-cmd`). Comments
  reuse this exact pattern — inert outside the iframe, so it never ships to prod.
- **Controls bar** (`app/[project_id]/chat/page.tsx`): the Preview/Code toggle + the new
  **Edit** button. The **Comment** button sits right next to Edit, same style/pattern.
- **Current route** is already tracked in the parent (`currentRoute`) from the reporter —
  that's the per-route key.

## Data model (Prisma)
```prisma
model Comment {
  id         String   @id @default(cuid())
  projectId  String   @map("project_id")
  route      String                      // e.g. "/", "/pricing" — per-route scoping
  // Anchor: element-relative so the pin survives scroll/resize/layout tweaks.
  anchorSelector String @map("anchor_selector")  // CSS path (same builder as the editor)
  relX       Float                        // 0..1 within the element's box
  relY       Float
  body       String
  resolved   Boolean  @default(false)
  authorId   String?  @map("author_id")   // the signed-in user (nullable while auth gate off)
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")
  project    Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  author     User?    @relation(fields: [authorId], references: [id], onDelete: SetNull)
  @@index([projectId, route])
  @@map("comments")
}
```
Stored in Claudable's DB only — the app source is never touched, so the deployed site
can't show them.

## Anchor model (why element-relative, not raw x/y)
A raw viewport coordinate breaks the moment the layout changes (responsive, new content,
an agent edit). Instead anchor each pin to an **element** (the same `cssPath` selector the
visual editor already computes) plus a **fractional offset** `(relX, relY)` inside that
element's box. The pin renders at `rect.left + relX*rect.width, rect.top + relY*rect.height`.
- Survives scroll/resize (recompute from the live rect).
- If the element no longer exists after an edit → the pin is **orphaned**; show it in a
  "needs re-anchoring" tray rather than at a wrong spot.

## Architecture — bridge draws pins, parent owns threads
Cross-origin iframe, so split responsibilities:
- **Inside the iframe (bridge):** render the small **pin dots**, anchored to their elements
  so they scroll naturally with the page. On comment-mode click, capture `(selector,
  relX, relY)` + the pin's screen rect and report to the parent. Continuously report pin
  screen positions on scroll/resize (throttled) so the parent can place thread popovers.
- **In the parent (Claudable):** the **compose box** and **thread popover** (positioned over
  the iframe using the reported screen coords), the **comments list panel**, and **Clear all**.
  Keeping the thread UI in the parent avoids iframe clipping and keeps comment text out of
  the previewed DOM entirely.

postMessage protocol (mirrors the editor's):
- Parent→iframe `claudable-comments-cmd`: `enter` / `exit` / `renderPins(pins[])` /
  `focusPin(id)`.
- iframe→parent `claudable-comments`: `placed({selector,relX,relY,screenRect})` (new pin
  spot picked), `pinPositions([{id,screenRect}])` (on scroll/resize), `pinClicked(id)`.

## UI
- **Comment button** next to Edit in the controls bar: toggles comment mode (amber/active
  state like Edit). Mutually exclusive with Edit mode.
- **Comment mode on:** cursor becomes a comment crosshair in the preview; clicking a spot
  drops a pin + opens a compose box (parent popover) → type → save.
- **Existing pins** for the current route render as numbered dots; clicking one opens its
  thread showing **the author's name** (+ avatar if set), the timestamp, the body, and
  resolve/delete. The author name is captured at create-time from the signed-in user and
  shown on every comment; falls back to **"Anonymous"** when created without a session
  (auth gate off).
- **Per-route:** when the route reporter fires a new `path`, the parent swaps the pin set
  (fetch comments for `project + route`).
- **Clear all:** wipes **every comment in the project** (all routes), behind a confirm.
- A small **count badge** on the Comment button (# comments on this route).

## API (`/api/projects/[project_id]/comments`)
- `GET ?route=/pricing` → comments for that project+route, each serialized with its
  **author's name** (+ avatar) joined from the User record.
- `POST` `{route, anchorSelector, relX, relY, body}` → create (authorId from session).
- `PATCH /:id` `{body?, resolved?}` → edit / resolve.
- `DELETE /:id` → remove one.
- `DELETE ?route=/pricing` (or `?all=1`) → clear all for the route (or project).
All gated like other project routes (auth when `AUTH_ENABLED`; owner/admin for mutations).

## Phased rollout
| Phase | Deliverable |
|---|---|
| 1. Data + API | `Comment` model + CRUD endpoints (+ clear-all). Testable via curl. |
| 2. Bridge | Extend the injected plugin: comment-mode click-capture + pin rendering + position reporting. Needs a preview restart to load (same as the editor). |
| 3. Parent UI | Comment button + mode + compose/thread popovers + per-route pin swap + Clear all + count badge. |
| 4. Robustness | Orphaned-pin tray, resolve/unresolve, optional replies, author avatars. |

## Decisions (locked 2026-07-01)
1. **Clear all → whole project** (all routes), behind a confirm.
2. **Pinned to a spot** — element-anchored numbered pins (element + fractional offset).
3. **Author = signed-in user** (name/avatar; "Anonymous" while the auth gate is off).
4. **Replies:** not in v1 — single comments first (Phase 4).
5. **Stack coverage:** Nuxt-only bridge to start (matches the editor); Next/Angular later.

## Rough effort
Phase 1 (model+API): ~half a day. Phase 2 (bridge): the tricky part — anchoring + position
reporting — ~1 day. Phase 3 (parent UI): ~1 day. Phase 4: incremental.
```
```
