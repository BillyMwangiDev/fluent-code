# Session archive and deletion

## Intent

Give finished sessions two distinct, safe lifecycle actions: **archive** hides a stopped session
while preserving its record; **delete** permanently removes that local session record without
silently deleting its working directory or isolated worktree.

## Decisions

- A running or starting lane cannot be archived or deleted. It must be stopped first.
- Archiving is reversible in the sense that the durable record remains accessible through the
  archived-session view; it carries an `archivedAt` timestamp.
- Deletion is deliberately a second step available only to an archived session. The UI requires a
  plain-language confirmation and the daemon requires a short-lived, action-bound approval.
- Deleting a session does not remove an isolated worktree, provider files, project files,
  coordination history, or usage data. Those are separate records and deletion must not imply a
  broader filesystem operation.

## Execution

1. Extend the session protocol and persistent summary with archive state plus archive/delete RPCs.
2. Enforce stopped-only lifecycle transitions in `SessionManager`; add a daemon approval boundary
   for deletion.
3. Add archive/delete controls to the session list and stopped session header, including an
   archived-session view and clear copy about retained worktrees.
4. Add lifecycle tests, typecheck, run tests, and browser QA with the fixture.

## Verification record

Implemented and verified on 2026-09-14.

- The protocol, daemon approval boundary, durable session manager, session list, archived-session
  view, and stopped-session controls now implement the two-stage lifecycle described above.
- `node --import tsx --test src/session-input.test.ts` passed (10 tests), including archive/restore/
  delete durability and a shutdown persistence regression.
- `pnpm check`, `pnpm run check:frontend`, `pnpm test` (248 tests), and `pnpm run test:frontend`
  (5 tests) passed with normal owner-local Unix-socket access. The restricted execution sandbox
  cannot bind that socket, so its coordination integration failure is environmental rather than a
  product failure.
