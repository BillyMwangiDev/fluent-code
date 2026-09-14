# Orchestration control surface

## Intent

Make the orchestration route the project command centre rather than a terminal grid with a task
list. A user can define one durable master brief, turn work into role/model-aware tickets, assign
or launch a lane for a ticket with a clean prompt, and review the lane's source-control path
without losing the existing inspectable coordination model.

## Existing ground to preserve

- `CoordinationManager` already persists tasks, claims, handoffs, decisions, and bounded history.
- `sessions.inject` can deliberately paste a task into an existing running lane.
- `api.createSession` owns the approval boundary for Claude project hooks and worktree creation.
- Merge planning and integration already require a review step and daemon-bound approval.
- GitHub actions beyond local review are not yet backed by daemon-side validation; this increment
  links to the source-control workspace instead of pretending it can publish or merge a PR.

## Done for this increment

1. Persist a project master brief and ticket metadata: description, specialization role,
   requested provider, source, and assigned lane.
2. Provide a Kanban board grouped by backlog, in progress, and done, plus a visible lane roster.
3. Let the user assign a ticket to a compatible running lane or launch a new isolated lane with a
   clean prompt containing only the master brief and that ticket's details.
4. Let the user start a planner lane from a selected Markdown/text specification. The planner gets
   a fresh context and explicit instruction to turn the spec into coordination tickets; it does
   not silently modify files or publish anything.
5. Surface the safe source-control path beside each lane: open its review/merge workspace or open
   the project source-control view. Any future PR publication/remote merge must add a dedicated
   daemon RPC plus an action-bound approval record first.

## Execution

1. Extend protocol, persisted coordination migration, RPC validation, and tests.
2. Extend the frontend API and replace the simple task rows with an orchestration brief, lane
   roster, ticket composer, Kanban columns, ticket assignment controls, and planner launcher.
3. Add compact styling that keeps the dense terminal-tool character.
4. Update the isolated visual fixture, typecheck, test, and perform browser QA.

## Verification record

- `pnpm check` passed.
- `pnpm run check:frontend` passed.
- `pnpm test` passed: 235 tests, including the owner-local coordination socket and a restart
  persistence test for master briefs and specialised assignments.
- `pnpm test:frontend` passed: 5 tests.
- `pnpm build:frontend` passed.
- Browser QA against `scripts/ui-qa-harness.html` confirmed the command centre renders the master
  brief, role/provider ticket composer, three Kanban states, running-lane assignment choices,
  isolated-lane launch controls, planner launcher, review links, and source-control navigation.
