# Coordination Explorer — Phase A

## Objective

Make Fluent's existing coordination state easier to investigate without changing its local-first
trust boundary: add a focused explorer to the Parallel Orchestration screen, with derived
object backlinks and personal, locally persisted views.

## Evidence and constraints

- `CoordinationState` already provides project tasks, advisory claims, decisions, messages and
  handoffs. `sessions.list` provides the live lane projection; `coordination.conflicts` provides
  ranked path collisions. No additional daemon state is necessary for this phase.
- The current orchestration route presents each collection in independent cards. It does not help
  a user answer which lane, claim, handoff, decision and verification result relate to one
  selected object. Only common-lane relationships can be derived from the current schema; task
  and claim records are not directly linked to each other.
- Personal presentation must remain local. Shared project state stays in `.fluent/` behind
  `fluentd`; selected explorer scope and layout preference live in `localStorage` only.
- The interface remains terminal-forward and dense. Coral remains restricted to actions and
  warnings; status information uses existing semantic colours.

## Completion criteria

1. Parallel Orchestration offers persistent personal scopes: Overview, Tasks, Files and Reviews.
2. Selecting a task, claim, handoff, decision, message, conflict or lane opens an inspector
   showing direct references and clearly labeled **shared-lane** inferences. It tolerates stopped
   and missing lanes. Current verification status is displayed as session state, never as history.
3. The page includes a compact, bounded **current-record activity** projection from retained
   creation records only; it never fabricates task transitions, claim release/expiry, handoff
   acceptance timestamps, terminal activity or an audit log.
4. Existing coordination mutations, task transitions, claim release, handoff acceptance, skill
   status and eval controls stay functional in Overview.
5. Every coordination mutation that accepts a session ID validates that the session belongs to the
   requested project before it changes state; cross-project agent messages and handoffs reject the
   same way.
6. The frontend typecheck, production frontend bundle, relevant daemon and pure-helper tests, and
   whitespace check pass. A fresh review checks the final implementation against this plan.

## Implementation

1. Add pure frontend helpers for collision-safe object identity, stable lane labels, relationship
   resolution and timestamped, bounded current-record activity. Resolve from current daemon
   projections only; do not synthesize records or use terminal output. Cover malformed dates,
   orphan lanes, containment conflicts, deterministic ordering and the absence of false direct
   task/claim links with tests.
2. Persist only the validated explorer scope under a versioned Fluent localStorage key and render
   a compact scope switcher. This is a personal saved view, intentionally not shared with the
   project or agents; project paths and selected objects remain transient.
3. Replace the unlinked coordination-card cluster with selectable dense rows and an inspector.
   Tasks retains task/decision controls, Files retains claim/release controls, Reviews retains
   handoff/message controls and current lane verification, and Overview retains all plus the
   skill/eval controls. Clear stale selections on refresh or project change.
4. Select the active project transiently from the project's available session lanes rather than
   assuming `sessions[0]` remains relevant. Add a daemon membership helper and use it for every
   coordination mutation that names a session; cover cross-project rejection in unit tests.
5. Add CSS primitives for keyboard-accessible selectable rows, scope tabs, relationship facts and
   the activity feed, covering narrow layouts without using Coral for ordinary data states.
6. Verify. If the plan exposes a real need for historical events or arbitrary saved user queries,
   make those a subsequent daemon/data-model phase rather than broadening this safe UI slice.

## Non-goals

- No arbitrary user queries or executable dashboard code.
- No Obsidian dependency, vault access, automatic export, sync integration, Canvas editor, or
  extension API.
- No replacement of advisory claims with locks or of merge-review/approval flows.
- No claim that the derived activity projection is an immutable audit log.

## Completion record

Completed 2026-09-14.

- Added a personal, versioned Coordination Explorer scope preference with Overview, Tasks, Files
  and Reviews projections. It persists only the validated scope locally; project selection and
  object selection remain transient.
- Added dense, keyboard-selectable coordination object links and a current-snapshot inspector.
  It explicitly describes task/claim/decision relationships as shared-lane inference, includes
  lane messages and current verification state, and clears stale objects after refresh/project
  changes.
- Added a bounded current-record activity projection. It includes only creation records still
  present in state and clearly excludes terminal, transition, release, expiry and audit history.
- Guarded daemon coordination mutations and observed claim sweeps against cross-project session
  IDs. The guard shares the coordination store's canonical project comparison.
- An independent review first narrowed unsupported history/backlink claims and found two final
  defects (message backlinks and observed-claim validation); both were corrected and rechecked.

Verification completed:

- `pnpm check:frontend`
- `pnpm build:frontend`
- `pnpm test:frontend` — 5 passed
- `node --import tsx --test src/claim-observer.test.ts src/coordination-membership.test.ts src/coordination.test.ts` — 36 passed
- `git diff --check`

`pnpm check` remains blocked by an unrelated pre-existing error in `src/pty-runtime.ts`:
`Property 'pkg' does not exist on type 'Process'.` It was intentionally left out of this scoped
change.
