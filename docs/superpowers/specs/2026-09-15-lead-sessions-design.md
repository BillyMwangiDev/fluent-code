# Lead sessions — design

Date: 2026-09-15. Requested by the user as "one main session orchestrating several sessions".

## Problem

Today the user is the only orchestrator. A spec-planner lane can add tickets, but every lane start,
ticket assignment, check-in, and stop is a click in the orchestration screen. A lane cannot start,
brief, observe, wait on, or stop another lane, so a main session cannot run sub-sessions.

## The tension, and how this design resolves it

The orchestration research says not to build an auto-decomposing lead agent and not to auto-spawn
lanes (`docs/research/2026-09-13-agent-orchestration.md` §2.1, §5): parallel agents cost roughly 15×
the tokens, and coordination must stay inspectable and user-controlled (spec §2.3).

A lead session is therefore **delegation the user grants**, not autonomy Fluent assumes:

1. **Off by default.** A session is a lead only when the user starts it as one and sets a lane
   budget (1–10, default 3). fluentd requires a `session.lead` approval for that grant.
2. **Bounded.** A lead may have at most `maxLanes` of its own lanes starting or running at once.
   Stopped lanes free their slot. The budget is the user's explicit cap, so it is enforced.
3. **No nesting.** A lane started by a lead cannot lead.
4. **Scoped authority.** A lead can assign, read, wait on, and stop only lanes it started. It cannot
   touch lanes the user started.
5. **Visible.** Every lane a lead starts records `parentSessionId`. The session list, session header,
   and orchestration grid show who started what, and assignments stay on the shared board.
6. **Advisory resources.** Each start reports the existing headroom assessment; it never blocks on
   it (spec §2.4).

This is a product boundary, not a security boundary: a process that speaks fluentd's raw socket
protocol can already call any RPC. The owner-only socket remains the security boundary (`cloud.md`).

## Per-provider pools (added 2026-09-16)

The user's mental model is a subagent ecosystem: they brief one **main agent** (Claude Code or
Codex), and it hands its own prompts to subagents that can come from any model — "five from Codex
and five from GLM". A lead's grant therefore carries an optional `pool`, a map of provider to the
number of lanes of that provider it may run at once. The pool's total is the budget. With a pool,
`lane start` refuses a provider outside it ("Your pool has no gemini lanes — it is 5 codex, 5
glm") and a provider whose share is fully running ("All 5 of your codex lanes are running (5/5)");
`lane list` shows each share (`lanes 3/10 · codex 2/5 · glm 1/5`). The briefing names the pool and
frames the session as the orchestrator: the user talks to it, its lanes hear only from it, and it
reads and answers what they report. The budget cap is 20 lanes.

In the desktop app the launch form's default mode is "main agent + subagents": pick the main agent,
write its brief, set the pool with one stepper per installed and connected provider. The workspace
opens focused on the main agent's terminal, its subagents line up after it, the composer talks to
the main agent by default, and the rail groups running lanes by project so several main agents on
several projects stay one click apart.

## Agent surface

A lead uses `fluent-coord lane …`, and the `fluent_coord` MCP tool gains the same operations as
`action: "lane"`. Output follows spec §11: compact tabular text, short ids, explicit zero counts.

| Command | Effect |
| --- | --- |
| `lane start PROVIDER [--shared] [--task ID] PROMPT...` | Starts a lane on the provider's active account. It gets an isolated worktree of the lead's project unless `--shared`. With `--task`, the ticket is assigned to it and its brief is part of the first prompt. |
| `lane list` | The lead's lanes: id, provider, status, idle time, assigned task. |
| `lane assign LANE TASK` | Assigns a ticket to one of the lead's running lanes and pastes the ticket brief into it. |
| `lane read LANE [--lines N]` | The last N lines (default 40, max 200) of that lane's terminal screen, rendered as text. |
| `lane wait [LANE...] [--timeout S]` | Returns as soon as any named lane (default: all of the lead's lanes) is ready, or at the timeout (default 60s, max 540s). |
| `lane stop LANE` | Stops one of the lead's lanes. Its worktree is kept. |

A lane is **ready** when it has exited, stopped, or failed; every task assigned to it is done; it
has unread mail for the lead; or it has an open handoff to the lead. These are all states fluentd
already records, so waiting never infers anything from terminal output. `wait` prints each lane's
state and idle time, so a timeout still tells the lead which lane to `read`.

### Report-back contract

A ticket brief ends with the report-back instruction: run `fluent-coord task done ID` and
`fluent-coord send LEAD SUMMARY`. `wait` detects both.

### Lead briefing

The lead is told about `lane` commands and its budget through each CLI's own channel: Claude Code
via `--append-system-prompt` alongside the existing coordination briefing, and the other providers
as a preamble to the first prompt, since they have no launch flag for project direction.

## fluentd

- `SessionSummary` gains `lead?: {maxLanes: number}` and `parentSessionId?: string`. Both persist
  with the session record.
- `sessions.create` accepts `lead: {maxLanes}` and requires a `session.lead` approval bound to the
  directory and budget.
- `agent.lane` is one lane-authenticated RPC with `action: start | list | assign | read | wait |
  stop`, resolved from the caller's working directory and `FLUENT_SESSION_ID` like every other
  `agent.*` call.
- A lead's lanes are created through `SessionManager.create` with the provider's resolved credential
  environment. The Claude hook write is covered by the lead grant for the lead's own project.
- `read` renders the retained output with `@xterm/headless` at the lane's current terminal size;
  stripping ANSI codes does not produce a readable screen for full-screen TUIs.

## Desktop

- **New session:** a "lead session" option with its lane budget.
- **Session list:** a lead shows `lead · running/max`; its lanes are listed directly under it and
  show which lead started them.
- **Session header:** a lead lists its lanes with open and stop actions; a started lane links back
  to its lead.
- **Orchestration grid:** lane tiles show `lead` or `↳ lead abcd1234`.

## Out of scope for this version

Promoting a session that is already running, changing a budget after start, nested leads, automatic
dispatch without a lead, Claude's turn-finished `Stop` hook as a wait signal, and spend ceilings.

## Verification

- Integration tests in `src/coord-cli.test.ts` against a real fluentd with stand-in provider CLIs:
  refusal for a non-lead and for a lead's lane; start within the budget and refusal beyond it;
  `list`; `assign` records the assignment and delivers the brief; `read` returns screen text; `wait`
  returns on a finished task or on mail and reports state at a timeout; `stop` refuses lanes the
  lead did not start.
- Unit tests for the screen renderer and the compact renderers.
- A Playwright check in the QA harness for the lead option, the grouped session list, and the header
  links.
