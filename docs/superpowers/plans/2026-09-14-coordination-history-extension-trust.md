# Coordination History and Extension Trust — Phase B

## Objective

Make two useful ideas from the Obsidian research real in Fluent Code without importing an
Obsidian workflow: retain meaningful coordination changes after the current board changes, and
make the source and execution boundary of provider extensions explicit before and after use.

## Evidence and constraints

- `CoordinationManager` atomically persists the project board in `.fluent/coordination.json`,
  but it currently loses task transitions, released/expired claims and handoff acceptance. The
  Phase A explorer correctly calls its feed **current-record activity**, not history.
- The coordination board is not an audit or terminal transcript. Raw terminal output, tool calls,
  credentials and duplicate message bodies do not belong in a coordination ledger.
- Existing catalog data has only `officialSource: boolean`. Claude marketplace source data is
  available but hidden from the UI; Codex marketplace sources are already read internally but
  are not returned. MCP rows expose an executable or endpoint but do not explain its trust level
  or the boundary it crosses.
- Provider CLIs remain the extension runtimes. Fluent must orchestrate their documented catalog
  and MCP commands, never emulate a plugin format or claim permissions it cannot prove.
- An `extension.install` approval is already daemon-enforced and bound to the exact command.
  Marketplace input should additionally be validated by the daemon before that approval is
  consumed, so an arbitrary CLI option/string cannot be smuggled through an extension source.
- The product is local-first, dense and terminal-forward. Source markers must be plain facts;
  Coral remains limited to actions and warnings.

## Completion criteria

1. Every meaningful coordination mutation records a bounded, durable event in the same atomic
   project state: task creation/status movement; successful and conflicting claim attempts;
   new observed paths; explicit/session-end/lease-expiry claim releases; decisions; handoffs;
   and sent lane messages. Lease heartbeats, mailbox reads and repeated idempotent claims do not
   add noise.
2. Claims receive a durable ID (with restoration migration), and historic events use stable
   object IDs, lane IDs, paths and statuses rather than copied agent
   prose. They remain useful if an active claim disappears, but never become a terminal log,
   credential store, or immutable audit promise. Pre-history state files restore safely.
3. The Coordination Explorer renders a compact, deterministic retained-history projection and
   links an event to a still-present object only when such a current object exists. The UI clearly
   distinguishes retained history from current relationships.
4. The catalog exposes a source provenance descriptor for every provider plugin, marketplace and MCP
   server: provider-bundled, provider-owned source, local source, third-party source or unverified remote source;
   exact source/executable/endpoint; and the concrete execution/network boundary Fluent knows.
   It does not invent capability grants or use an unsupported generic plugin sandbox.
5. The catalog lists configured Claude and Codex marketplaces, carries source provenance into
   plugin rows and install confirmation, and validates new marketplace sources as a local path
   or a GitHub repository/URL before daemon approval and CLI invocation.
6. MCP registration retains structured executable arguments, requires HTTPS for remote servers
   as before, and surfaces whether the server runs a local process or connects to an unverified
   remote endpoint in the existing list and confirmation.
7. Existing provider commands and approval bindings remain unchanged in scope. Frontend helper
   tests, daemon tests, frontend typecheck/build, and whitespace validation pass; an independent
   final review checks the committed result against this plan.

## Implementation

1. Extend the shared protocol and app mirror with a discriminated `CoordinationEvent` (`id`,
   daemon timestamp, kind, optional actor lane, participating lane IDs and structured record
   references), a durable `FileClaim.id`, and a bounded `events` array. Define one named maximum
   per project, sort retained history by timestamp plus event ID and trim the oldest entries.
   Add a central recorder in `CoordinationManager` which appends to the current project's atomic
   state snapshot. Restore missing claim IDs, discard malformed event records safely and keep the
   newest valid bounded events.
2. Record structured events inside each existing mutation at the point it changes the board.
   Store IDs, path, origin, status and participating lanes; avoid copied task/decision/handoff
   summaries or message bodies. Define observed-path removal as its own release reason. Do not
   add events for unchanged task status, a second accepted handoff, lease renewals, mailbox reads
   or an idempotent declared claim. Promote an existing observed claim to declared intentionally
   and record it as a real change. Preserve current return values and lease/conflict semantics.
   Agent-driven operations pass an actor lane; UI-driven acceptance remains deliberately
   unattributed. Cover restoration, event ordering/bounding, every non-noisy mutation and release
   reason.
3. Replace Phase A's creation-only explorer helper with a pure retained-history resolver.
   Resolve labels and selectable subjects from the latest board only; unresolved historical
   events stay readable non-links. Cover deterministic dates, current-object resolution and
   release/conflict labels in frontend tests.
4. Introduce a shared catalog provenance descriptor with a small closed vocabulary and factual
   disclosures. Derive it from Claude/Codex marketplace source metadata and portable MCP config;
   return it for plugins, marketplaces and MCP rows. Distinguish a confirmed bundled catalog from
   a provider-owned repository string; unresolved Codex marketplace-name mappings remain unknown.
   Add a combined marketplace list so Codex sources are visible too.
5. Redact URL credentials, query/hash values and secret-like executable arguments from every
   catalog display value, while retaining the raw structured declaration only for the existing
   local provider command/approval path. The UI distinguishes local-process launch from remote
   HTTPS connection and shows safe structured argument disclosure.
6. Validate marketplace additions in `catalog-manager` and call that validation before daemon
   approval consumption. Accept absolute local paths plus canonical GitHub owner/repo, HTTPS
   GitHub and GitHub SSH repository forms; reject relative paths (the daemon cwd is not a user
   project reference), blank, option-like, control-character, credential/query/fragment and
   ambiguous/non-GitHub remote forms with a useful error. Continue passing the original approved
   source to each provider CLI through `execFile`, never a shell.
7. Update catalog rows, marketplace listing and install/add confirmations to show the exact
   safe provenance and factual risk disclosures. Keep `confirm` as a second UI acknowledgement,
   but leave daemon approval as the authoritative enforcement boundary.
7. Run the scoped test suites, frontend checks/build and diff check. Ask a fresh reviewer to
   verify the completed files against this plan, fix any verified gap, then stamp this plan with
   the exact verification result.

## Non-goals

- No Obsidian dependency, vault, Canvas, plugin API, sync integration or export.
- No unbounded append-only audit log, terminal transcript, agent prompt archive or secret store.
- No claim locking, automatic conflict resolution, or remote collaboration service.
- No assertion that marketplace/MCP metadata is a permissions manifest; Fluent labels known
  boundaries and lets the provider own extension format and runtime behavior.
- No marketplace support beyond Claude Code and Codex, and no generic third provider runtime.

## Completion record

Completed 2026-09-14.

- Added stable claim IDs and a 500-event, per-project retained coordination journal. It records
  task transitions, meaningful claim changes and release reasons, decisions, handoffs and lane
  messages without duplicating agent prose or recording heartbeats, mailbox reads or idempotent
  operations. Compatibility restoration rejects malformed events, persists generated legacy claim
  IDs before restart, and does not rewrite an already normalized journal for object key order.
- Replaced the Phase A creation-only activity feed with retained coordination history. It links
  only to a current matching stable object; released or otherwise vanished records remain readable
  plain text rather than being mis-linked to a later claim.
- Replaced coarse `officialSource` labels with evidence-based catalog provenance. Fluent now lists
  both Claude and Codex marketplaces, carries safe source provenance into plugin rows and exposes
  factual local-process versus remote-HTTPS MCP boundaries. Raw MCP command, args and endpoints
  stay inside catalog registration/approval paths and never cross the catalog RPC to the frontend.
- Added daemon-side marketplace validation before approval consumption. Only absolute local paths
  and canonical GitHub repository forms reach provider CLIs; option-like, relative, credentialed,
  query/fragment and unrelated remote forms are rejected.
- Independent review found and corrected two real defects before completion: legacy claim IDs were
  initially generated without an immediate write, and raw MCP configuration still crossed the
  catalog RPC. A final independent review passed after both fixes and after the no-rewrite restore
  refinement.

Verification completed:

- `node --import tsx --test src/coordination.test.ts src/catalog-manager.test.ts app/src/coordination-explorer.test.ts` — 33 passed
- `pnpm check`
- `pnpm check:frontend`
- `pnpm test:frontend` — 5 passed
- `pnpm build:frontend`
- `git diff --check`
