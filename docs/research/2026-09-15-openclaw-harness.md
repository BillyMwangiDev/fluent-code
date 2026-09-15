# OpenClaw's harness: what Fluent Code can borrow

Date: 2026-09-15. Source: `github.com/openclaw/openclaw` at `3d3386a2` (2026-09-15), read from its
docs and spot-checked against source. Paths below are inside that repository.

## TL;DR

OpenClaw and Fluent Code solve different problems. OpenClaw is a personal/team assistant: one
always-on Gateway that owns an agent loop, routes chat channels to agents, and runs coding
harnesses as one kind of backend. Fluent Code is a desktop orchestrator for real, unmodified coding
CLIs. Most of OpenClaw's surface (channels, its own agent loop, model failover, OpenAI-compatible
endpoints) is out of scope for Fluent. What is worth borrowing is the machinery around running
external harnesses and parallel work, where OpenClaw is further along:

| Rank | Borrow | Why it matters for Fluent | Where it lands |
| --- | --- | --- | --- |
| 1 | ACP adapters for structured lanes | Structured approvals, resume, and permission modes for Claude Code and Codex without parsing a TUI | Opt-in lane mode beside PTY lanes (research R1) |
| 2 | Background-task ledger with push completion | Replaces lead `lane wait` polling; one source for notifications | `fluentd` run store + lead sessions |
| 3 | Queue modes: steer, followup, collect, interrupt | `sessions.inject` is a raw paste today; lead→lane briefs need turn-aware delivery | Inject RPC + Codex `turn/steer` |
| 4 | Worktree snapshot before removal, `.worktreeinclude`, setup script | "Remove worktree" discards uncommitted work today | `worktree-manager.ts` |
| 5 | Persisted native session ids for resume | Stopped or daemon-lost lanes are gone for good today | Session manager (done in 70f7e4d) |
| 6 | Board diagnostics (stranded, heartbeat-less, orphaned, missing proof) | Makes stuck parallel work visible instead of silent | Coordination + orchestration screen |
| 7 | Lane contracts and "specialists do not delegate" | Sharper briefs for lead-started lanes | `ticketBrief` / lead briefing |
| 8 | Protocol min/max negotiation and operator scopes | Remote daemons and read-only viewers | `daemon-protocol.ts`, remote manager |
| 9 | Optional remote channel with pairing and loop protection | Approve or answer a lane from a phone | Later; after OS notifications |

## 1. Vocabulary: OpenClaw separates four layers Fluent currently merges

`docs/concepts/agent-runtimes.md` draws a line Fluent's `ProviderId` does not:

| Layer | OpenClaw examples | Meaning |
| --- | --- | --- |
| Provider | `anthropic`, `openai` | How it authenticates and names models |
| Model | `claude-opus-5`, `gpt-6-astra` | The model for the turn |
| Agent runtime (harness) | `openclaw`, `codex`, `claude-cli`, ACP | The loop that executes the turn |
| Channel | Telegram, Slack, WebChat | Where messages enter and leave |

Fluent's `ProviderId` means "which CLI to launch" and doubles as "which credential chain". That is
fine while every runtime is a PTY CLI, but it breaks as soon as one provider can run two ways (a
Claude Code PTY lane and a Claude ACP lane on the same account). Borrowing the split early —
credential provider, model, and runtime as separate session fields — keeps the credential broker
unchanged when structured runtimes arrive.

OpenClaw's design rule for mixed ownership is also directly usable (`agent-runtimes.md`, "Runtime
ownership"): if the host owns a surface it can hook it; if the native runtime owns it, the host
needs runtime events or native hooks, and it mirrors native thread state rather than rewriting it.
That is Fluent's "orchestrate, don't rebuild" rule stated as a per-surface table, and it is a
better shape for the capability matrix the product-completion plan calls for.

## 2. How OpenClaw runs coding harnesses

OpenClaw has three paths, and only the latter two are relevant to Fluent.

**Built-in runtime.** OpenClaw owns the model loop, tools, compaction and transcript
(`src/agents/`, `packages/agent-core/`). Fluent should not copy this; it is exactly the harness
Fluent refuses to rebuild.

**Codex app-server harness** (`extensions/codex/`, `docs/plugins/codex-harness.md`). Codex owns the
thread, native resume, tool continuation and compaction; OpenClaw owns delivery, approvals, and a
transcript mirror. Details worth copying:
- Thread control is a first-class command set: bind, threads, resume, steer, stop.
- Stopping interrupts the active turn and then stops the native background terminals listed on that
  thread, and reports an error if cleanup fails instead of claiming success.
- Native Codex sub-agents are shown under their parent, and a waiting mailbox is not treated as
  proof a child finished.
- Saved-account quota comes from `account/rateLimits/read` in a temporary app-server, which is a
  cleaner quota source than transcript scraping.

Fluent already runs a Codex app-server observer beside the PTY (`src/codex-app-server.ts`). The
next step OpenClaw shows is using the same channel for `turn/steer`, thread resume, and rate limits.

**External harnesses through ACP** (`extensions/acpx/`, `docs/tools/acp-agents*.md`). OpenClaw runs
Claude Code, Codex, Gemini CLI, OpenCode, Cursor and others through the Agent Client Protocol.
The plugin depends on `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`
(`extensions/acpx/package.json`). Notable mechanics:
- **Process ownership.** Every spawned adapter carries a lease id and gateway instance id
  (`src/process-lease.ts`), and a reaper only kills trees it can prove it owns
  (`src/process-reaper.ts`). Fluent hit the orphaned-lane problem for real on 2026-09-14; a lease
  in the child's argv is a sturdier ownership proof than PID bookkeeping.
- **Permission modes without a TTY:** `approve-reads`, `approve-all`, `deny-all`, plus
  `nonInteractivePermissions: fail | deny` (`docs/tools/permission-modes.md`). Structured form and
  URL requests surface as operator questions; URLs are shown, never fetched.
- **Resume** via `resumeSessionId`, and completion delivered to the parent through the task path
  rather than peer chat, which avoids parent/child echo loops (`acp-agents/delivery.md`).

**Claude Code as a CLI backend** (`extensions/anthropic/cli-transport.ts`,
`cli-runtime-args.ts`). OpenClaw drives Claude Code over `--input-format stream-json
--output-format stream-json`, keeps one warm subprocess per compatible turn, persists Claude session
ids so conversations survive restarts, and runs a no-output watchdog. It never reads or forwards
Claude's own login tokens.

**What this means for Fluent.** The README's open gap — approval prompts rendered only as terminal
text — has a well-trodden fix: an opt-in structured lane that runs the provider's own harness
through its ACP adapter (or Claude's stream-json mode), with approvals as Fluent cards. It does not
break the one rule: the agent loop is still the provider's, not Fluent's. It should stay beside,
not replace, PTY lanes, because a structured lane has no TUI and some users want the real terminal.

## 3. Parallel work, delegation, and completion

**Lane contracts first, coordinator last** (`docs/concepts/parallel-specialist-lanes.md`). Each lane
gets a written contract — owns, does not own, chat budget, handoff rule, tool-risk rule — before
any coordinator exists; "a coordinator without lane contracts just coordinates chaos." The team
preset instructs specialists to return results without delegating further, which matches Fluent's
no-nesting rule for lead sessions. Global concurrency is capped (`maxConcurrent`,
`subagents.maxConcurrent`).

**Completion is push, not poll** (`docs/automation/tasks.md`,
`docs/concepts/subagent-yield-handoff.md`). Detached work is a task record moving
`queued → running → succeeded | failed | timed_out | cancelled | lost`, retained for 7 days, with an
audit command. A requester can *yield*: its turn ends, the registry owns the children's completion,
and when they settle a successor turn is admitted with the batch results. Delivery is bounded
(attempts, replays, stale deferrals), and progress is coalesced into one update per batch every 15
seconds under a per-task policy (`done_only`, `state_changes`, `silent`).

For Fluent this is the natural next step for lead sessions: instead of the lead blocking in
`fluent-coord lane wait`, fluentd records each lane's run as a task and, when a lead's lanes settle,
pastes one compact settlement summary into the lead. The same ledger feeds OS notifications.

**Queue modes** (`docs/concepts/queue.md`, `queue-steering.md`). A message arriving mid-run is
`steer` (inject at the next tool or model boundary), `followup` (after the run), `collect`
(coalesce into one later turn), or `interrupt` (abort, then run). Codex receives batched
`turn/steer`. Fluent's `sessions.inject` always pastes and presses Enter immediately, which is
`steer` with no boundary awareness. A followup mode needs a turn-finished signal; Claude Code's
`Stop` hook provides it, and Fluent does not subscribe to it yet.

**Managed worktrees** (`docs/concepts/managed-worktrees.md`). Snapshots of tracked and non-ignored
untracked files before removal; `.worktreeinclude` to copy selected ignored files such as
`.env.local`; an executable `.openclaw/worktree-setup.sh` run in each new checkout; APFS/Btrfs/ReFS
clone templates; and a disk-space reserve checked before allocation. Fluent's "remove worktree"
warns that uncommitted changes are discarded — a snapshot-then-remove path is a direct safety win.

**Board diagnostics** (`packages/workboard-contract/src/index.ts`). The workboard names failure
states explicitly: `stranded_ready`, `running_without_heartbeat`, `blocked_too_long`,
`repeated_failures`, `missing_proof`, `orphaned_session`, `archived_but_active`. Fluent's board has
the data for several of these (claims with leases, verification results, lanes that exited with an
active task) but does not surface them.

**Provenance** (`docs/concepts/multi-agent.md`). Agent-created agents record their creator, need
operator approval, and show as a tree. Fluent's lead sessions already record `parentSessionId` and
require an approval; a tree view in the session list would complete the parallel.

## 4. Channels

OpenClaw's defining feature is chat channels (`docs/channels/`): 30+ channel plugins, deterministic
routing where the model never chooses the channel (`channel-routing.md`), session keys per peer,
group or thread, DM pairing with short expiring codes and a pending cap (`pairing.md`), an explicit
command owner, and bot-to-bot loop protection with a per-pair sliding window and cooldown
(`bot-loop-protection.md`). `openclaw mcp serve` exposes conversations to Claude Code or Codex as
MCP clients (`docs/cli/mcp.md`).

Fluent is a local desktop tool, so a channel layer is not a priority. One narrow use is real: being
told a lane needs you, and answering it, while away from the machine. If Fluent ever adds that, the
parts to copy are pairing plus a single owner allowlist, deterministic routing to one lane, loop
protection, and treating inbound text as untrusted data. It should follow local OS notifications,
not precede them.

## 5. Tools and approvals

- **Policy tightens, never loosens.** Effective exec policy is the stricter of config and approval
  defaults (`docs/tools/exec-approvals.md`). Tool allow/deny is enforced at the Gateway regardless
  of what the agent's instructions say (`docs/concepts/delegate-architecture.md`).
- **Approvals bind what will run.** Approved commands bind cwd, exact argv, environment, and the
  resolved executable (real path, plus a content hash for writable executables); drift between
  approval and launch denies the run. Fluent's approval records bind target, command hash and base
  SHA; adding executable identity for recipe runs is a small, concrete hardening.
- **Named permission modes** (`docs/tools/permission-modes.md`): `deny`, `allowlist`, `ask`, `auto`
  (reviewer-assisted), `full`, with an explicit mapping onto Codex's approval policy and sandbox.
  This is the "two-dial" model spec §8 describes, with names a UI can show.
- **Loop detection** (`docs/tools/loop-detection.md`) hashes stable tool outcomes to spot
  no-progress repetition. For Fluent this could be an advisory lane warning fed by Claude hooks.

## 6. Infrastructure

- **One Gateway, one multiplexed port**, WebSocket RPC with typed schemas and protocol
  `minProtocol`/`maxProtocol` negotiation (`packages/gateway-protocol/src/schema/frames.ts`).
  Fluent's single `fluentProtocolVersion` will need a range once remote daemons of different
  versions coexist.
- **Operator scopes** (`docs/gateway/operator-scopes.md`): read, write, admin, approvals, pairing.
  Useful if Fluent adds a read-only remote viewer; unnecessary for the owner-only local socket.
- **Singleton guard** (`docs/gateway/gateway-lock.md`): a state-directory lock, a socket bind, and a
  health probe of an existing owner before failing. Fluent already landed the same lesson
  (refuse to start when the socket answers); the state-directory lock is worth matching.
- **Doctor with migrations** (`docs/gateway/doctor.md`): runtime reads only the current config
  shape, and every breaking change ships a `doctor --fix` migration. Fluent migrates state inline on
  restore today; a `fluentd doctor` would make those repairs inspectable.
- **Automation**: cron, hooks, heartbeat, and standing orders (`docs/automation/`). Heartbeat runs
  periodic agent turns, which conflicts with Fluent's cost principles and should not be copied.

## 7. What not to borrow

- The built-in agent loop, compaction, and model transport — the harness Fluent exists to avoid.
- Cross-model failover and cyber-policy model escalation. Fluent switches credentials, never
  models, and never proxies model calls.
- OpenAI-compatible HTTP endpoints, multi-tenant roles, and team gateways.
- Heartbeat turns and standing-order autonomy.
- Channel breadth and a 166-extension plugin catalogue.

## Suggested order

1. Persisted native session ids and resume (done in 70f7e4d).
2. OS notifications from lane status and Claude `Notification` hooks (done in ff96995), then a task ledger with push
   completion that lead sessions use instead of polling.
3. Worktree snapshot-before-remove and `.worktreeinclude`.
4. A structured ACP lane mode for Claude Code and Codex, with approval cards and permission modes.
5. Board diagnostics and a session tree view.
6. Turn-aware inject modes (Codex `turn/steer`; Claude `Stop` hook for followup).
