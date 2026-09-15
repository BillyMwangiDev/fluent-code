# Product-completion implementation plan

## Mandate

Implement the remaining Fluent Code product gaps incrementally. The aim is a local-first desktop
orchestrator that makes provider/account selection, approvals, coordination, remote access,
design handoff, and evidence visible and safe without taking control away from the user.

## Starting point

The working tree already contains uncommitted implementations for session archive/delete, linked
Qwen/GLM/NVIDIA OpenCode accounts, durable run observations, catalog validation, and associated
tests. On 2026-09-14, the current tree passed `pnpm check`, `pnpm run check:frontend`, `pnpm test`
(248 tests), and `pnpm run test:frontend` (5 tests) when the daemon was allowed to bind its local
Unix socket. The sandbox itself blocks Unix socket binding, so socket integration tests must run
outside it.

This document does not claim ownership of those pre-existing edits. Preserve them and make each
subsequent increment compatible with them.

## Done means

1. Finished session records can be safely archived, restored, and deliberately deleted without
   deleting a checkout or worktree.
2. Provider-native approval requests appear in one inspectable, action-bound approval surface
   wherever a provider documents a structured protocol. Providers without that contract retain an
   explicit terminal-only fallback; terminal text is never guessed to be an approval request.
3. Remote targets have validated profiles, safe reconnect states, clear local/remote identity,
   and remote telemetry. Unsupported operating-system paths state the limitation rather than
   suggesting they work.
4. Design handoff moves selected local OpenDesign/Pen context into a repository-bound Fluent task
   through a documented, permissioned interface. Intended paths become advisory file claims only
   when the user selects a live lane and requests that reservation; visual checks are evidence,
   never auto-approval.
5. Extension and preview surfaces are safe for third-party content: canonical input validation,
   an explicit trusted-source policy, daemon-side approval records, and a restrictive CSP.
6. Advanced orchestration (structured adapters, task DAG/checkpoints, warm slots, recipes,
   scheduling, and optional race mode) is introduced only behind evidence-backed provider and
   safety contracts, with normal PTY lanes remaining functional.

## Execution order

### 1. Stabilize the current lifecycle baseline

- Keep archive/delete stopped-only and two-step; verify that deletion only removes the durable
  session record. Record the successful verification in its dedicated plan.
- Turn the post-test temporary-directory persistence noise into a deterministic shutdown/flush
  path if it can happen in production, without concealing actual state-write failures.
- Perform browser QA against the session fixture and retain the command/result in the plan.

### 2. Close the extension and embedded-content boundary

- Centralize accepted marketplace sources into a policy that distinguishes a user-selected
  absolute local path from canonical GitHub sources. Reject ambiguous transports before invoking a
  provider CLI, and require the existing daemon approval record for every install.
- Apply the same boundary to portable MCP declarations, including an explicit display of local
  executable versus remote endpoint risk.
- Replace the permissive Tauri CSP with the smallest policy that permits Fluent assets, the local
  daemon bridge, and the explicitly user-enabled loopback Design service. Add tests for the policy
  generator and retain an explicit opt-in for the loopback origin.

### 3. Establish structured-provider capability truth before a unified approval UI

- Research and record current official contracts for Codex app-server and Claude/Gemini structured
  modes. A protocol is supported only after a versioned transcript fixture proves its lifecycle,
  approval, interruption, and resume semantics.
- Add a typed capability matrix and provider event envelope. The PTY route remains the default
  compatibility path, and no terminal-output parser may fabricate an approval card.
- Render the shared approval inbox from that envelope. Its actions consume short-lived daemon
  approval records bound to the provider/run/action; all unsupported providers clearly remain
  terminal-controlled.

### 4. Make remote operation recoverable and observable

- Validate SSH profile inputs and host identity before activating a forward. Persist reconnect
  state rather than silently reconnecting to a different host or project.
- Add explicit local/remote daemon identity and protocol-version checks, with a mismatch as a
  blocked state. Surface reconnect actions and remote resource/software/usage snapshots.
- Add platform-specific coverage; retain Windows forwarding as unavailable until exercised by a
  real Windows test fixture.

### 5. Complete a permissioned design-to-build loop

- Keep local OpenDesign probing loopback-only. Add a stable, documented handoff input that records
  screen/component/token references, source mappings, and an affected-file claim before a task is
  created.
- Add deterministic preview evidence (route, viewport, console/network/a11y state, screenshot)
  and an approval-bound baseline update. A mismatch can create a scoped task but never starts an
  agent or overwrites the baseline.

### 6. Build advanced orchestration in safety order

- Introduce durable task/dependency/checkpoint records and restart states first.
- Add the project-scoped warm-slot pool and calibrated, advisory admission only after isolation
  tests establish cache, port, and credential separation.
- Add a reviewed `fluent.recipe.json` runner and evidence receipts before automated preview QA.
- Finally add bounded race mode only for independent, verified tasks with an explicit cost/time
  ceiling.

## Cross-cutting rules and verification

- Every new daemon mutation has a daemon-side validation and approval boundary where it can alter
  credentials, extensions, remote access, worktrees, baselines, or provider state.
- Preserve explicit provider, account, model, and credential-chain context in every session view.
- Run daemon and frontend typechecks plus focused tests per increment; run the complete suite and
  real-browser QA before recording an increment complete. Socket tests require normal local socket
  access, not the restricted sandbox.
- Update README/cloud limitations only when the matching code and verification are complete. Do
  not erase a limitation merely because a UI control exists.

## Progress record

### 2026-09-14 — session lifecycle stabilization

- Archive/restore/delete was verified as a stopped-only, approval-bound lifecycle. Deletion removes
  only the Fluent session projection.
- `SessionManager.shutdown()` now waits for a PTY exit path to write its last redacted observation
  and run state before flushing; it escalates a non-exiting child only during daemon shutdown.
- Verified with focused lifecycle tests plus the complete daemon and frontend suites.

### 2026-09-14 — safe SSH remote activation

- Remote profile inputs now reject option-like/ambiguous SSH destinations and unsafe Unix-socket
  paths. Persisted profiles are revalidated and their local tunnel endpoints are regenerated.
- A tunnel must complete a versioned Fluent `ping` handshake before becoming connected; a merely
  accepting or incompatible socket is rejected. Disconnect and daemon shutdown own and await
  tunnel cleanup, and the Remote screen exposes port and remote-socket configuration.
- Verified with a fake SSH/socket integration test, input-validation tests, and the complete
  daemon/frontend suites. Automatic recovery is bounded and opt-in; Windows forwarding remains
  unimplemented pending platform coverage.

### 2026-09-14 — structured Codex safety foundation

- The Codex app-server observer now completes the documented `initialize` / `initialized`
  handshake and parses the documented command, file-change, and permission approval request
  envelopes. It retains opaque server request IDs and does not mistake a network approval for a
  shell command.
- This remains an observer alongside the real PTY, not a substitute for it. If an observer-side
  request arrives, Fluent replies fail-closed (`decline`, or an empty permission subset) rather
  than hanging or authorizing a provider action. A cross-provider approval card still requires an
  adapter that owns the provider turn.
- Verified against a protocol fixture that requires the fail-closed response and documented
  initialization sequence. Contract reference: https://learn.chatgpt.com/docs/app-server

### 2026-09-14 — structured design-to-build handoff

- Design tasks now persist repo-relative source mappings, component and token specifications, a
  loopback preview URL, and de-duplicated intended implementation paths. They are injected into
  the focused builder brief when a lane is assigned.
- The Design workspace can explicitly assign an active owner, reserve those paths as advisory
  claims, and propose a different active lane as reviewer. It neither claims files nor hands work
  to a lane without the user selecting those actions.
- Restore and validation tests cover metadata persistence, escaped paths, and non-loopback
  previews; daemon and frontend typechecks pass.

### 2026-09-15 — embedded local-content boundary

- OpenDesign now distinguishes a reachable loopback service from a user-enabled embedded origin.
  State written before that grant restores with embedding disabled. Preview and OpenDesign origin
  selection are canonicalized by the native desktop process.
- The Tauri CSP now prohibits embedded frames. Preview and OpenDesign use dedicated local webviews
  with a native navigation guard that allows only the exact per-surface loopback origin selected
  for this app run. The window can follow same-origin routes but cannot turn a saved origin into a
  credentialed, different-port, or remote navigation.
- Verified with daemon/frontend typechecks, the full daemon suite (302 tests), the frontend suite
  (15 tests), focused OpenDesign migration tests, and native origin-guard tests for
  canonicalization and exact-origin matching.

## Plan critique

The main risk is treating undocumented provider protocols as stable. The plan prevents that by
requiring fixture-backed capability proofs and retaining the PTY fallback. Remote access and
embedded Design content are privileged boundaries, so they precede feature breadth. A separate
fresh-context review is normally required for a plan of this size; delegation is not available in
this run, so each completed increment will receive an independent source/test/QA pass and this
plan will remain the acceptance specification.
