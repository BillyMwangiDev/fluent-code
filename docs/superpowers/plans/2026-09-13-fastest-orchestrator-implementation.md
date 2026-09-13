# Fastest orchestrator implementation plan

**Status:** Phase 0 foundation in progress; phases 1–7 remain planned  
**Owner:** Fluent Code  
**Basis:** [speed research](../../research/2026-09-13-fastest-agent-orchestrator.md),
[orchestration research](../../research/2026-09-13-agent-orchestration.md), and the implemented
daemon/session/worktree/coordination surfaces in `src/` as inspected on 2026-09-13.

## 1. Goal and truth conditions

Fluent must not claim to make a frontier model generate tokens faster. The product goal is:

> Add no material overhead to a direct provider session, and reduce elapsed time to a **verified,
> integrated outcome** for work that can safely benefit from orchestration.

That requires a provider-native execution path, warm isolated environments, scheduling based on
measured capacity and dependencies, and an evidence loop for code and visual work. It must work
for all of these task shapes:

| Task shape | User-visible promise | Required mechanism |
| --- | --- | --- |
| Short task | Start quickly and return a tested patch without a heavyweight lane. | Warm headless run, direct structured event stream, bounded evidence and verifier. |
| Long task | Survive app/network interruption without duplicating work. | Durable run record, provider-native session identity, checkpoints, resumption and approval/blocked states. |
| End-to-end app | Build, test and inspect a real app rather than stopping at code generation. | Project recipe, isolated worktree, dev server/browser harness, test/a11y/network/visual evidence and integration gate. |
| Design work | Turn a screen specification into inspectable implementation work. | Repository-native design contract, source/DOM mapping, screenshots/diff, accessibility evidence and a constrained handoff. |
| Parallel/team work | Be faster only when tasks are independent enough to compensate for coordination cost. | Explicit DAG, claims, mailbox, worktree isolation, admission advice, verification-gated merge queue and optional race mode. |

The current local IPC ping is diagnostic only. No performance marketing is permitted until the
matched bare-versus-Fluent benchmark in phase 0 has passed; a missing provider timestamp is
reported as unavailable, never counted as a win.

## 2. Architecture to build

Keep Fluent local-first: the Tauri app is the client and `fluentd` owns state, processes,
worktrees and provider connections. Preserve the current direct-provider credential model. Remote
support is currently a thin SSH Unix-socket-forwarding preview, not an authenticated Fluent remote
protocol; it must be hardened before a run can safely attach to it. Do **not** introduce a
Fluent-hosted model proxy or remote Fluent service as part of this plan.

```text
Tauri UI / CLI
      │ versioned daemon RPC + subscriptions
      ▼
fluentd ── Run store ── Trace store ── Scheduler ── Coordination / verification / merge queue
      │                     │                 │
      ├── provider-adapter contract ───────────┼── Codex structured adapter
      │                                        ├── Claude structured/headless adapter
      │                                        └── PTY compatibility adapter
      │
      └── workspace controller ── worktree pool ── recipe runner ── browser/visual evidence
```

### 2.1 One canonical execution model

Create a versioned model owned by the daemon. A provider adapter may expose more information,
but cannot invent or silently discard a state transition.

```ts
type Run = {
  schemaVersion: 1; id: string; taskId?: string; origin: 'ad_hoc' | 'task'; attempt: number;
  provider: ProviderId; accountId?: string;
  mode: 'interactive' | 'headless'; class: 'micro' | 'feature' | 'long' | 'race';
  state: 'queued' | 'preparing' | 'ready' | 'running' | 'awaiting_approval' |
    'blocked' | 'verifying' | 'integrating' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
  adapter: {id: string; version: string; capabilities: CapabilitySet};
  providerSession?: {threadId?: string; sessionId?: string; resumable: boolean};
  workspace?: WorkspaceLease; checkpoint?: CheckpointRef; timing: TimingMap;
};

type RunEvent = {
  schemaVersion: 1; id: string; runId: string; sequence: number; clockEpochId: string;
  atMonoMs: number; atWall: string;
  type: 'run.state_changed' | 'run.ready' | 'prompt.dispatch_intended' |
    'prompt.dispatch_confirmed' | 'run.delivery_unknown' | 'provider.first_event' |
    'text.delta' | 'tool.started' | 'tool.finished' | 'approval.requested' |
    'approval.resolved' | 'usage.updated' | 'checkpoint.created' |
    'verification.finished' | 'integration.finished' | 'stream.resync' |
    'run.finished' | 'run.failed';
  payload: RedactedPayload; source: {adapter: string; providerEvent?: string};
};
```

`sequence` is per run, `clockEpochId` prevents incomparable monotonic timestamps across daemon
restarts, and all raw/provider-specific payloads stay behind a redaction boundary. The transition
table is finite and tested: every change of `Run.state` emits `run.state_changed {from, to,
reason}`. A PTY adapter may emit terminal data and lifecycle state but declares which timing fields
it cannot observe. It records dispatch intent before a write; after a crash without a provider
acknowledgement it enters `run.delivery_unknown` and requires a human recovery decision. It never
automatically resends input. A structured adapter may auto-resume only when it has a stable,
deduplicated provider request/session identity. A structured adapter can power the same terminal
view; the terminal must never become the system of record for task state.

### 2.2 Proposed module boundaries

Add modules rather than turning the existing `SessionManager` into a provider-specific monolith.

| Area | New module(s) | Existing surface to adapt | Responsibility |
| --- | --- | --- | --- |
| Execution protocol | `src/execution/types.ts`, `events.ts`, `run-store.ts`, `event-bus.ts` | `daemon-protocol.ts`, `daemon.ts`, `daemon-client.ts`, `app/src/{api,main}.ts`, `src-tauri/src/{daemon_client,lib}.rs` | Versioned run lifecycle, durable append-only events, subscriptions, bridge compatibility and migration. |
| Provider adapters | `src/execution/adapters/{types,pty,codex,claude}.ts` | `providers.ts`, `codex-app-server.ts`, `session-manager.ts`, `hook-relay.ts` | Capability probe, start/resume/cancel/send, structured event mapping and explicit fallback. |
| Scheduling | `src/orchestration/{task-dag,scheduler,admission,context-pack,checkpoint}.ts` | `admission.ts`, `coordination.ts`, `worktree-manager.ts`, `verification.ts`, `merge-queue.ts` | Task dependencies, placement advice, leases, recovery and integration order. |
| Evidence | `src/evidence/{recipes,browser,artifacts,visual}.ts` | `verification.ts`, `open-design-manager.ts`, app preview views | Deterministic build/browser evidence and retention. |
| Measurement | `src/perf/{trace,redaction,benchmark-runner,statistics}.ts` | `daemon-client.ts`, `eval-runner.ts`, Usage Observatory | Accurate benchmark artifacts, comparison and redacted export. |
| Secure persistence and approval | `src/security/{secure-state,approval-records}.ts` | all daemon state stores, `hooks-config.ts`, verification/merge/remote/catalog RPCs | Owner-only durable state, legacy migration and daemon-enforced risk authorization. |

`SessionSummary` remains as a backwards-compatible projection during migration. Every old session
is represented as an ad-hoc `Run` backed by the PTY adapter before new screens depend on the
model. A schema migration is idempotent and tested against a state directory from the current
release. Existing JSON is legacy sensitive data, not an indefinitely retained backup: phase 0
hardens its permissions, inventories it, migrates only redacted fields and gives the user a
reviewable expiry/scrub path for any retained raw output. The daemon, Rust bridge and app either
negotiate the new subscription capability together or retain the exact old event/RPC contract;
there is no partially upgraded subscriber.

### 2.3 Security and privacy invariants

These are release gates, not follow-up work:

- Provider credentials, authorization headers, prompt text marked sensitive, repository secrets,
  and tool environment variables are removed before a new event, benchmark or support bundle is
  persisted or exported. Raw terminal and verification output is memory-only unless the user has
  explicitly enabled encrypted local retention; tests use known canary secrets across every store,
  diagnostic and error path to prove this. Legacy state is handled by the migration policy above.
- A shared secure-state utility creates state directories at `0700`, regular files and temporary
  files at `0600`, rejects symlinks/non-regular files, repairs or warns on legacy modes, and fsyncs
  an event/snapshot file and parent directory before declaring a durable write. Daemon state,
  trace, checkpoint and remote-socket files use it. Remote forwarding requires explicit SSH
  host-key policy, owner-only local socket setup, and a daemon hello/version/project-identity
  handshake before a run is attached.
- No adapter bypasses a provider permission request. Fluent presents one auditable approval queue
  with exact command/path/tool scope; benchmarks use the same approval policy in both arms.
- Recipe commands and browser targets are explicit project configuration, run in the selected
  worktree, time-bounded, cancellable and shown before first execution. Local preview access does
  not grant access to arbitrary network hosts.
- Checkpoints are Git references/metadata, not hidden destructive snapshots. Restoring, merging,
  deleting a worktree or changing credentials retains the product's explicit approval rules.
- The daemon—not only the UI—validates a single-use, expiring approval record for every risky or
  destructive RPC. The record binds action type, canonical target, command/recipe hash and, where
  relevant, base SHA; it covers credential changes, worktree deletion/reset/rebase, integration,
  remote configuration/connection, extension installation and recipe execution.

## 3. Delivery order

The order intentionally establishes measurement and structured provider control **before** a
scheduler, visual system or race mode. Each phase has an independently shippable boundary and a
hard gate. Durations are planning ranges for one focused engineering stream; provider-version
experiments may change them.

| Phase | Range | Deliverable | Depends on | Exit gate |
| --- | ---: | --- | --- | --- |
| 0. Truthful measurement foundation | 1–2 weeks | Run/event schema, redacted trace, reproducible benchmark harness and corpus | none | Benchmarks produce complete, repeatable artifacts; no speed claim yet. |
| 1. Structured execution foundation | 2–3 weeks | Codex adapter drives a real thread/turn; PTY sessions projected into the same run model | 0 | Capability-gated real-provider contract suite passes; safe PTY degradation works. |
| 2. Short-task path and Claude parity | 2–3 weeks | Claude headless structured execution, minimal leased warm micro-run path, unified approval/event UI | 0, 1 | Matched Claude and Codex short-task trials record all available timestamps and quality checks. |
| 3. Durable tasks and coordination | 3–4 weeks | DAG, checkpoints/resume, context packs, merge-aware scheduler | 1, 2 | Restart/reconnect does not replay prompts; dependency and claim tests pass. |
| 4. Fast isolated environments | 2–3 weeks | Worktree pool, recipe cache policy, calibrated admission and queueing | 3 | Lane-ready distribution and isolation tests meet their declared project-specific target. |
| 5. End-to-end build/QA loop | 3–4 weeks | Recipe runner, browser evidence, artifact handoff and acceptance gate | 3, 4 | Fixture apps pass build/test/a11y/console/network evidence reproducibly. |
| 6. Design-to-build and visual approval | 3–4 weeks | Design contract, mapping, baseline/diff and mismatch task handoff | 5 | Design fixture produces source/DOM/visual evidence and an actionable review record. |
| 7. Scaling, race mode and proof | 2–3 weeks | Heterogeneous race mode, scheduler tuning, public benchmark publication | 0–6 | Published suite meets the falsifiable outcome target or reports the miss. |

### Phase 0 — truthful measurement foundation

**Implement**

1. Audit current mutation paths and add a daemon-enforced approval-record service **before** new
   execution work. It creates a single-use, expiring record bound to the action type, canonical
   target, command/recipe hash and base SHA. Apply it to existing and new credential,
   worktree deletion/reset/rebase, integration, remote, catalog-install and recipe-execution RPCs,
   as well as `ensureClaudeHooks()` project configuration writes and configured verification
   commands. Status reads and non-mutating local projections remain automatic; the client may
   request approval but cannot forge it.
2. Add `Run`, `RunEvent`, `CapabilitySet`, an `ad_hoc` run origin, finite transition table,
   dispatch-intent/outcome state, clock epoch and redaction API. Add a daemon event subscription
   that resumes from an event sequence, with backpressure and bounded per-subscriber buffers. It
   defines a retention/compaction floor and priority classes. A slow UI may lose terminal deltas,
   but never lifecycle or approval events; it receives `resync-required {from, snapshot,
   terminalGap}` rather than a false promise of exact terminal reconstruction.
3. Introduce `RunStore` with append-before-publish semantics: persist state transition and event,
   then notify UI. Persist a compact snapshot plus append log; recover only completed writes.
4. Instrument existing `SessionManager` through the PTY adapter: worktree start/end, process
   spawned, ready, dispatch intent, output observed, exit, verification and integration. Mark
   `provider.first_event` unavailable for a terminal-only run. A crash after intent but before a
   proven provider acknowledgement becomes `delivery_unknown`, never an automatic retry.
5. Update daemon capability/version negotiation, the Rust daemon bridge and the `app/` subscription
   path together. Define snapshot/event ordering across the subscribe boundary and reconnect from
   a durable cursor. Existing clients retain their exact session subscription until the new
   resumable subscription is available end-to-end and has a tested resync route.
6. Create `benchmarks/` with versioned fixture repositories for micro edit, isolated feature,
   long-running repair, full-app change and parallel integration. Each fixture pins dependency
   lockfile, runtime, browser, viewport, test command and expected evidence.
7. Pre-register a comparator definition for each provider/mode pair before it runs: fixed
   provider/CLI/model/account mode/sandbox/prompt/initial commit/acceptance evaluator, common
   observable clock boundary, cache policy and explicit start/end clocks. Compare only boundaries
   observed by both arms; report warm/cold setup and lane-ready time separately from model-turn
   timing. The CLI (`pnpm benchmark` after it is added) then runs bare and Fluent arms in randomized
   paired order on reset environments and captures machine/OS/Node/CLI versions, provider quota,
   cache state, configuration, timings, provider-reported tokens/cost, test result and artifact
   hash. One explicit cost/budget approval authorizes a declared run set; it cannot expand the set
   or incur unapproved provider spend.
8. Implement statistics that emit raw redacted JSONL, an immutable manifest, median/p95, paired
   deltas, bootstrap confidence intervals, successes/failures/timeouts and an HTML/Markdown
   report. Human approval and review time are separately reported, never hidden in a total.

**Tests and gates**

- Unit-test approval-record expiry/replay/canonicalization, event ordering, duplicate replay,
  slow subscribers, disconnect between snapshot and subscribe, reconnect, compaction-floor resync,
  crash-between-append-and-publish, log compaction, redaction and resumption.
- Inventory every current persistence and diagnostic path—sessions, verification, usage, logs,
  benchmark artifacts and error strings—then canary-test it. Use the secure-state utility for all
  new state; test permissions, symlink rejection, fsync recovery and legacy-mode repair/warning.
- Add fixture checks proving every pre-registered comparator uses its fixed prompt, provider
  CLI/model/account mode, repository commit, sandbox, acceptance evaluator and approval policy.
- Run a local no-provider control-plane benchmark in CI and retain raw samples. It must report p50,
  p95, p99, host metadata and connection lifetime; it replaces the current non-reproducible ping.
- Treat every model-backed result as an opt-in local artifact until a documented publication policy
  exists. The target is a valid benchmark, not a favorable number.

### Phase 1 — structured execution foundation (Codex first)

**Why first:** `src/codex-app-server.ts` already handles its stdio lifecycle and quota events, but
it is explicitly observational and has no identity for the concurrently launched Codex PTY thread.
Phase 1 begins with a discovery gate: either a documented attach/shared-thread contract exists, or
the app-server is the sole owner of a new structured run. A PTY fallback is a separate run path;
it is never a second controller for the same provider session.

**Implement**

1. Run a time-boxed protocol-discovery spike against each candidate Codex version. Record its
   accepted initialize schema, thread/turn/item methods, provider IDs, resume/dedup semantics and
   whether a documented attach contract exists. Explicitly test whether `usage.rate_limits` is
   emitted by the installed version — sources disagree on this, so the matrix must record it per
   version rather than assume the app-server exposes it. Stop at a compatibility matrix; do not
   infer an attach mechanism from matching local directories or terminal output.
2. Define `Adapter.probe()`, `start()`, `resume()`, `send()`, `interrupt()`, `cancel()`,
   `checkpoint()`, `capabilities()` and async `events()`. Every adapter reports installed CLI and
   schema version; unsupported operations return a typed capability error rather than a guessed
   command.
3. If the discovery gate proves it, expand `CodexAppServer` as the **sole** controller for a new
   structured run. Map provider IDs to Fluent run and event IDs, pass provider approvals to the
   unified queue, and retain raw messages only in the redacted diagnostic stream. Otherwise retain
   the PTY adapter and label structured execution unavailable for that version.
4. Add an adapter conformance suite using a recorded protocol transcript plus an optional,
   explicitly enabled authenticated smoke test. The latter covers create/turn/stream/interrupt/
   approval/resume/error; failures set a persisted compatibility status and force PTY fallback.
5. Migrate the session RPC methods and UI projections one command at a time. Existing terminals,
   session list, quota display, claims, verification and merge flow remain functional throughout.

**Tests and gates**

- No real Codex binary is assumed by unit tests. Transcript tests pin exact schema versions.
- A user can choose the PTY compatibility path when a capability probe fails. A pending write with
  unknown delivery becomes a reviewable recovery state and is never automatically replayed.
- On a supported installed version, a turn's provider-first-event and tool timings appear in the
  trace; on an unsupported one the UI says why that timing is unavailable.

### Phase 2 — short-task path and Claude parity

**Implement**

1. Add a Claude adapter that uses the documented headless structured output path (`stream-json`) for
   `micro` work and keeps the existing interactive PTY for live terminal sessions. Map structured
   output plus the existing additive hook relay into the common event envelope; hooks stay
   non-blocking and short. Before treating `stream-json` as the only structured transport, evaluate
   `@agentclientprotocol/claude-agent-acp` (research R1, still open) for permission requests, edit
   review and nested subagent transcripts; if adopted it feeds the same adapter contract rather than
   replacing it.
2. Build the minimal leased warm micro-run substrate: one reusable prepared worktree slot,
   validated provider executable and a reviewed `WarmupManifest` limited to safe setup commands—
   not the later `fluent.recipe.json`, a resident agent holding an unapproved task, or a shared
   mutable `node_modules`. Lease it to one run, reset/revalidate it on return, and evict on
   credential/project/adapter incompatibility. Phase 4 generalizes this to a calibrated multi-slot
   pool and phase 5 introduces the broader recipe format.
3. Add task classification with user override. `micro` is a small, independent change with an
   estimated bounded command set; `feature` and `long` begin as normal lanes. Classification only
   selects a default; it never suppresses approvals or silently parallelizes work.
4. Render a single approval/blocked-state inbox, event timeline and evidence receipt in the app.
   Provider/account/credential fallback remain visible on every run.

**Tests and gates**

- Headless and PTY Claude modes pass the same fixed acceptance evaluator and publish a declared
  normalized capability matrix. Their output, permission and turn semantics are not presumed
  identical; unavailable fields remain unavailable and headless permissions are never weakened for
  a timing result.
- Pool reset is tested for Git dirt, processes, ports, generated files, credentials and cache
  isolation. A dirty or unknown slot is destroyed, not reused.
- For each supported provider, run at least the predeclared paired short-task trial count from
  phase 0. Report quality and cost alongside latency; do not select only winning trials.

### Phase 3 — durable tasks and coordination

**Implement**

1. Add durable `Task`, `TaskEdge`, `Attempt`, `Checkpoint`, `Artifact` and `Integration` records.
   A task has explicit dependencies, acceptance criteria, preferred provider/capability and a
   declared work class. The user can inspect and edit the DAG before scheduling.
2. Create checkpoints at safe boundaries: before a tool batch, after a verified artifact, before
   integration, and on a supported provider's own resumable session point. Store a lane Git ref
   plus immutable run metadata; never fake recovery by resending the prompt.
3. Add restart/reconnect state handling: after daemon restart, probe provider session identity,
   reattach if supported, otherwise mark the run `lost` with a safe recovery action. Before any
   remote attachment, harden the SSH-forwarded preview with an explicit host-key policy, owner-only
   local socket, authenticated daemon hello, protocol-version and canonical project-identity match;
   reject a mismatch and expose reconnect state.
4. Implement a scheduler that only chooses among ready DAG nodes. Its initial score uses explicit
   dependency criticality, provider/account availability, credential cache locality, measured
   lane-ready time, worktree availability, quota headroom, hardware headroom, overlapping claims
   and prior run evidence. The score and its inputs are shown, and "advisory" never becomes a hard
   refusal in this phase.
5. Bind every task, claim, message and artifact to a daemon-canonical project root and run/lease;
   resolve symlinks and reject outside-root or foreign-session identifiers. Then build bounded
   context packs from the authorized task board, claims, decisions, mailbox, relevant diffs and
   verification receipt. Each pack is project/run-bound, secret-scanned, source-authorized,
   size-limited and expiring. A structured adapter uses a provider-supported request/ack ID for
   delta delivery; a PTY receives an immutable on-disk/viewable pack or agent CLI command and is
   never automatically written to while it may be handling a tool or approval.
6. Extend the current verification-gated merge queue with build-conflict prediction and explicit
   acceptance states: `passed`, `failed`, `unavailable`, `not-applicable` and `overridden`.
   `unavailable` cannot yield a "verified" integration; it requires an approved persisted override
   with a reason, or produces an integration-only outcome. Compare
   changed exported APIs/configuration and project dependency graph where available. It produces a
   warning/ranking, never a fabricated semantic-conflict verdict.

**Tests and gates**

- Kill/restart daemon scenarios cover every run state, prove a PTY prompt is never automatically
  replayed, and permit automatic structured-adapter recovery only with documented provider
  deduplication.
- DAG tests cover cycles, missing dependencies, cancellation propagation, blocked approvals and
  deterministic tie-breaking.
- Context-pack tests show a lane can read all relevant claim/decision/handoff state without
  receiving an unrelated project's private data.
- Context-pack delivery tests prove an interactive PTY is never written to implicitly, and prove
  expiry, project/run binding, source authorization and secret scanning.
- Two concurrently modifying fixture lanes must surface overlapping claims, order integration and
  preserve both patches or give a reviewable conflict—not silently overwrite either.

### Phase 4 — fast isolated environments and calibrated admission

**Implement**

1. Evolve the phase-2 minimal slot into a project-scoped slot pool. A slot is a detached worktree at a
   recorded base SHA with a lease, generation, clean-state proof, warmed paths, recipe outcome and
   filesystem capability. Keep only a small configurable number per project.
2. Detect reflink/CoW eligibility and record the actual strategy. Define and enforce a per-tool
   cache policy: content-addressed immutable caches may be reflinked/read-only; mutable build
   directories, process output and port leases are per-lane; package-manager stores use their
   documented isolated configuration. Check symlink escapes before warming. Rebase/reset a slot
   only by explicit, logged Git operations after the lease has ended.
3. Replace one-size admission recommendations with a calibrated per-project model using observed
   CPU, memory, disk I/O, network, process tree, quota and prior lane throughput. The recommendation
   stays purely advisory — visible headroom and a suggested wait, never a queue, delay or other
   auto-gated start. `docs/research/2026-09-13-agent-orchestration.md` §6 already considered and
   rejected a queued "start when recommended" mode for v1; reversing that needs its own recorded
   decision, not a default introduced here.
4. Add capacity-aware scheduling and release: maintain a fast path for a warm `micro` lease,
   preserve cache affinity where credentials allow, and avoid co-scheduling known hotspot files or
   high-disk build recipes.

**Tests and gates**

- Isolation tests run simultaneous installs/builds and prove no lane can mutate another lane's
  working tree, credentials, port lease or output receipt; cache-policy tests cover mutation,
  symlink escape and concurrent installers per supported toolchain.
- Benchmark lane-ready time separately from model time, grouped by cold/warm cache and filesystem
  strategy. Set project-specific p95 targets only after a baseline is collected.
- Disk-pressure, low-memory, stale slot and non-reflink hosts degrade to safe fresh worktrees with
  an explicit explanation.

### Phase 5 — end-to-end app build and QA loop

**Implement**

1. Define recipe trust before adding a repository `fluent.recipe.json` (with detected-but-
   reviewable defaults) for install, dev, build, test, lint, routes, environment requirements,
   browser command and acceptance steps. A recipe is project content, versioned in Git, never an
   opaque daemon heuristic: an uncommitted agent-modified recipe is not authoritative; any command,
   environment, route or version-digest change requires renewed user consent.
2. Create the recipe runner with structured command start/end/output/exit events, port leases,
   cancellation and cleanup. Reuse phase-4 worktree isolation and show risky commands for
   approval.
3. Harden the Tauri security policy before adding a pinned browser/device harness: the current CSP
   is `null`, so define capabilities and a restrictive CSP, run preview browsing without Tauri IPC
   or credential forwarding, enforce navigation/request allowlists, block unapproved downloads,
   and tear down its bounded processes/ports. The harness then captures route, console errors,
   failed network requests, accessibility scan, DOM/source map hooks and screenshots. Store
   content-addressed evidence with viewport/runtime/route metadata; distinguish an unavailable
   browser check from a pass.
4. Attach a concise evidence receipt to a run and context pack. A follow-up lane gets only the
   failed command, relevant logs, affected route/source mapping and screenshot diff—not an entire
   noisy transcript.
5. Make integration require the declared acceptance checks or an explicit human override with a
   reason. Existing verification stays the default baseline when no recipe is committed.

**Tests and gates**

- Build fixture: changed component → dev/build/test → route capture → a11y/console/network
  receipt → integration. It runs deterministically in CI under a pinned browser version.
- The harness handles port collision, server crash, route timeout, console error, network error
  and screenshot failure as explicit evidence states.
- Security tests attempt preview navigation, request and data-exfiltration paths outside the
  declared allowlist, Tauri-IPC access, recipe-digest substitution and orphaned process/port use.
- Review samples prove route screenshots and logs do not accidentally contain secrets or private
  environment values.

### Phase 6 — design-to-build and visual approval

**Implement**

1. Define a repository-native `design/fluent-contract.json` (or equivalent documented format)
   covering tokens, component states, screen/route mapping, viewport, content fixtures, asset
   source, acceptance annotations and source ownership. The repository Pen source at
   `design/pen/fluent-code.pen` and its documented exports are updated in the same PR as each
   design-contract change.
2. Build a new, permissioned OpenDesign/Pen handoff after selecting a stable API; current
   `OpenDesignManager` only stores/probes a loopback URL and is not a file-level integration.
   The handoff needs stable screen identity, selected component/token references, source-file
   mapping and an explicit affected-file claim before an agent edits.
3. Generate approved screenshot baselines only through a review action. Compare candidate capture
   using deterministic viewport/content, pixel diff plus semantic layout/accessibility checks; the
   numeric diff is a review signal, not autonomous proof of visual correctness.
4. Turn a mismatch into a scoped task containing route, baseline/candidate, DOM/source mapping,
   design contract references, a11y/console/network evidence and claimed files. The user decides
   whether to queue it, assign it or dismiss it.
5. Build dense design-status, visual-evidence and handoff views in the windowed Tauri `app/`,
   using the Fluent dark terminal-forward design language and the Pen artboards as source of truth.
   Provider/account, lane state, claim conflict and approval remain explicit.

**Tests and gates**

- A design fixture detects an intentional token/layout mismatch and produces a source-scoped,
  reviewable task; no agent is auto-started.
- Baseline changes require an explicit approval record and cannot be overwritten by a failed run.
- DOM/source mapping, image assets and Pen/OpenDesign data have a documented permission and
  retention policy.

### Phase 7 — scaling, race mode and proof

**Implement**

1. Add an opt-in race task type. It fans out a bounded number of independent attempts with a
   declared cost/time ceiling, independent worktrees and the same acceptance verifier. The first
   *verified* result wins; other attempts are interrupted, retained as evidence and never silently
   merged.
2. Require a decomposition review before multi-lane fan-out: no dependency edge, no overlapping
   claim, enough quota/capacity, known acceptance checks and a user-visible estimate of cost.
   Serial execution is the default when those conditions do not hold.
3. Tune scheduler weights from phase-0–6 traces using held-out fixtures, then freeze a release
   candidate and compare it to direct provider arms. Never tune and evaluate on the same trials.
4. Publish a redacted benchmark kit and reports: fixture source, exact provider/CLI/model setup,
   policy, hardware, randomization, all runs, failures/timeouts, raw timing summaries, quality,
   cost and confidence intervals. Do not publish prompts, credentials, code or traces without
   permission.

**Release gate**

The only allowed "fastest" claim is qualified by provider/version/corpus/machine and requires all:

- added median prompt-to-first-provider-event is no more than both 1% of bare median and 100 ms
  for a supported structured adapter;
- local control-plane p95 is below 250 ms on the declared long-lived connection measurement;
- Fluent has at least 20% lower median time to **verified** outcome on the published independent
  task suite, without lower success rate or statistically meaningful total-cost increase; and
- every trial—including failures, rate limits and fallbacks—is included in the report.

If a gate misses, ship the useful feature with the observed claim (for example, "warm worktrees
reduce lane-ready time on APFS") and fix or drop the broader performance claim.

## 4. Feature-to-phase coverage

| Needed capability | Implementation phase(s) | User-facing outcome |
| --- | --- | --- |
| Provider-native structured control | 0–2 | Accurate lifecycle/approval/tool/usage state without fragile terminal scraping. |
| Bare-equivalent speed proof | 0, 1, 2, 7 | Matched numbers rather than an assertion based on local IPC. |
| Short tasks | 2, 4 | Warm, bounded headless execution with normal approvals and verification. |
| Long tasks | 3 | Checkpoint/reconnect/blocked states and no duplicate prompt on recovery. |
| Parallel tasks | 3, 4, 7 | DAG-aware allocation, transparent claims, mailbox, merge queue and bounded race mode. |
| Full app delivery | 4, 5 | Isolated project recipe plus build/test/browser/a11y/network/visual evidence. |
| Design work | 5, 6 | Stable design contract and reviewable design-to-code handoff. |
| Security and privacy | 0–7 | Redaction, owner-only local state, explicit approvals, isolated execution and audit receipts. |
| Remote use | 3 | Hardened authenticated/versioned SSH socket attachment, not an unapproved cloud backend. |
| Frontier-provider expansion | 1–2 then decision gate | Adapter parity—not a terminal wrapper—before a provider is advertised as supported. |

## 5. Decisions that must be made before their phase

These decisions do not block phase 0. They prevent building an ambiguous product later.

| Decision | Latest point | Proposed default | Why it matters |
| --- | --- | --- | --- |
| Codex supported schema/version matrix | Phase 1 implementation | Support only versions proved by a transcript + authenticated smoke test. | Prevents driving an undocumented control protocol. |
| Claude structured transport | Phase 2 implementation | Use CLI headless structured output for micro runs; retain interactive PTY. | Preserves current user workflow while adding measurable events. |
| Claude ACP adoption | Phase 2 implementation | Evaluate `@agentclientprotocol/claude-agent-acp` alongside `stream-json`; adopt only where it adds permission/edit-review/subagent-transcript fidelity the headless path lacks, without weakening approval semantics. | Research (R1) leaves this open; skipping it silently would drop a documented capability without a recorded reason. |
| OpenRouter scope | Before new adapter work | Keep it as a billing/routing compatibility configuration until a real model-agnostic execution contract is designed. | Credential, approval, recovery and benchmark semantics otherwise remain unclear. |
| Gemini/other provider expansion | After Claude/Codex parity | Treat as a separately approved product expansion with full parity gates. | Current product contract names Claude and Codex; a CLI launch alone is not support. |
| Trace retention/export | Phase 0 release | Local by default, redacted, user-configurable retention; explicit consent for export. | Traces contain prompt, code and tool metadata. |
| Visual comparator policy | Phase 6 | Human approval for baseline updates and merge decisions. | Avoids mistaking a pixel score for product correctness. |
| OTel `gen_ai` trace export | Phase 7 or later, opt-in | Defer: map `RunEvent` to OTel `gen_ai` semantic conventions only once an external consumer needs it — the phase-0 event schema is already shaped for this, so the mapping stays cheap when it's picked up. | Research (R10) is low-cost and unstarted; recording the default keeps it from being silently forgotten. |

## 6. First implementation increment (start here)

Implement phase 0 as seven small, reviewable PRs. This is the work that should start immediately;
it creates the evidence and compatibility foundations every later feature relies on.

1. **Authorization and secure state** — inventory every mutation/persistence path; add the
   daemon-issued approval record and secure-state utility, then protect or migrate legacy state.
   No execution model ships before the existing risky RPCs are daemon-gated.
2. **Execution types and tests** — add `src/execution/types.ts`, finite state transitions,
   delivery-unknown semantics and redaction tests. No provider runtime behavior changes; define
   event availability, clock epoch and schema evolution policy.
3. **Durable event store** — add `RunStore` with fsync-safe snapshot/log recovery, event sequencing
   and `ad_hoc` session projection. Preserve old `sessions.create/list/get` shapes.
4. **PTY instrumentation** — wrap current sessions in the PTY adapter and publish lifecycle,
   worktree, dispatch-intent and verification events. Preserve terminal output and current RPC
   shapes; a post-crash write stays unknown until the user resolves it.
5. **Resumable bridge/UI receipt** — add capability negotiation, cursor/resync subscription and a
   compact timing receipt across daemon, Rust bridge and `app/`. Render unavailable timing fields
   honestly and retain the old subscription during transition.
6. **Reproducible local benchmark** — commit control-plane harness, manifest and CI test that
   emits p50/p95/p99 with host metadata and raw redacted samples; replace ad-hoc results.
7. **Opt-in provider benchmark skeleton** — commit resettable fixtures, pre-registered comparator
   definitions and an interactive declared-budget command that validates equivalence before it
   spends provider quota. It may ship with zero provider results; correctness comes first.

Each PR runs `pnpm check`, `pnpm check:frontend`, `pnpm build`, `pnpm build:frontend`, focused
Node tests and `cargo check`; it also adds its own recovery/redaction/contract tests. Keep the
existing working session, credential broker, worktree, coordination, verification and merge queue
behaviors intact while their data is projected into the new model.

## 7. Progress reporting and documentation

Maintain a `docs/benchmarks/README.md` describing commands, consent, environment capture,
fixture reset and interpretation. Add a phase checklist to the design spec and update `README.md`,
`cloud.md`, `AGENTS.md` and `CLAUDE.md` when a user-facing architecture or workflow changes—not
merely when a source file changes. The Usage Observatory should show an explicit label for
measured, inferred and unavailable values.

At the end of every phase, publish a short engineering receipt: schema/adapter version, fixtures
run, pass/fail counts, known capability gaps, security review result, benchmark delta (if any) and
the next gate. That keeps the speed goal falsifiable while the product gains real capability.

## 8. Planning record

Prepared on 2026-09-13 from the cited research and a read of the current daemon, provider,
worktree, remote, desktop and design surfaces. A separate fresh-context review was completed
before this plan was published. It changed the plan materially: phase 0 now starts with
daemon-enforced approvals and secure persistence; legacy PTY recovery has an explicit
unknown-delivery state; Codex structured execution has a protocol-discovery gate; remote support
is treated as a thin preview requiring hardening; and the desktop bridge, recipe/browser security,
cache policy, context isolation and Pen source-of-truth work are all explicit dependencies.

No implementation from this roadmap has been started by this planning document. The authorized
starting point is the seven-PR phase-0 sequence in §6; its first deliverable is the security and
approval foundation on which the execution and measurement work depends.

A later review verified every concrete file/behavior claim in this plan against the codebase
(none were found wrong) and cross-checked it against both research docs and the product spec. It
made three corrections: phase 4's admission step had reintroduced a queued "start when recommended"
mode that `agent-orchestration.md` §6 had already considered and rejected for v1 — reverted to a
strictly advisory recommendation; Claude ACP adoption (research R1, left open) and OTel `gen_ai`
trace export (research R10, unstarted) had no phase, module or decision-table entry — both are now
tracked as explicit decisions in §5 rather than silently dropped.

## 9. Implementation receipt — 2026-09-13

The first Phase 0 increment is now in the repository. It adds daemon-owned, owner-only secure
state; single-use, expiring approval records bound to action/target/command hash/base SHA; a
versioned `Run`/`RunEvent` model with finite transitions; a redacted append-before-publish run
store; cursor/resync event delivery; and an `ad_hoc` PTY projection that never replays a prompt
after a crash. Session output, task text, and verification output are no longer written to the
durable state projection. Existing session RPCs remain available during migration.

The local control-plane benchmark, fixture registrations, comparator manifest, redacted JSONL
writer, immutable sample hash, and p50/p95/p99/paired-report statistics are implemented. The
default benchmark is intentionally provider-free. There are no provider-backed speed results or
marketing claims: those remain opt-in work gated by a committed comparator, an approval-bound
budget, and the phase-0 equivalence rules.

Verified with `pnpm check`, `pnpm check:frontend`, `pnpm build`, `pnpm build:frontend`, `pnpm
test`, `cargo check` in `src-tauri`, and `pnpm benchmark` using a temporary local artifact
directory. During verification, macOS `/var` versus `/private/var` aliases were canonicalized in
session and coordination identity handling so a worktree cannot split into two project states by
path spelling.
