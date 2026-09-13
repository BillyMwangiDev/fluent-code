# Agent orchestration — research findings and recommendations

Status: research complete. R2.1, R3, R4 and R5 are implemented; the rest are pending review.
Implementation status is tracked per recommendation in the table below.
Companion docs: [the design spec](../superpowers/specs/2026-09-13-fluent-code-design.md) (§§3, 7.5, 10, 11, 14 are
the sections this report argues with), [`AGENTS.md`](../../AGENTS.md), [`CLAUDE.md`](../../CLAUDE.md).

**The question this answers:** what does the research literature and the open-source field actually
know about orchestrating coding agents, and what would make Fluent Code the best and fastest
orchestrator in the world?

**Method and its limits.** Every claim below is sourced, and sources are listed in §7. Papers were
read via their abstracts/summaries and secondary technical write-ups; `arxiv.org` and
`anthropic.com` were unreachable from this environment's egress proxy, so primary PDFs of the
cited papers were not opened directly — numbers attributed to them should be re-verified against
the PDF before any of them lands in marketing copy. Repository descriptions come from the two
maintained directory lists (§7), not from cloning and running each tool. Where a finding is
reported by a vendor about its own product, it is labelled as such.

---

## 0. The short version

The field has commoditized the *shape* Fluent Code is building — worktree-per-agent, a session
list, a diff viewer — about 200 times over (§1). None of that is a moat, and Fluent already has
most of it. What nobody has solved, and what the research says actually determines whether
parallel agents are faster than one agent, is the two ends of the pipeline:

1. **Getting a lane productive** — latency from "start a lane" to "the agent is working with a
   warm cache" (§2.5).
2. **Getting a lane's work back into main** — 27.67% of AI-agent PRs hit textual merge conflicts,
   and 41.7% when two *different* agents touch the same code (§2.3). Fluent runs mixed-provider
   lanes by design, which puts it in the worst bucket in that dataset — and makes it the only tool
   in the category positioned to fix it.

Everything in the middle — the agent turn itself — is already excellent and not Fluent's to build
(spec §1, the one rule).

**The twelve recommendations**, ranked by leverage per unit of work:

| # | Recommendation | Why it matters | Phase | Status |
|---|---|---|---|---|
| R1 | Structured control channel per provider (ACP + `codex app-server`), PTY kept for rendering | Unlocks R6/R7/R8/R9/R10; closes the spec §14 Codex-parity risk | v1 | not started |
| R2 | Integration as a product surface: predictive claims + serialized merge queue | The 27.67%/41.7% conflict problem; Fluent's most exposed *and* most defensible edge | v2→v3 | **part 1 done** — overlap-aware claims with leases; diff-derived claims and the merge queue remain |
| R3 | Verification gate on the repo's own checks before a lane reads "done" | MAST's largest failure category; agent self-report is not evidence | v1 | **done** |
| R4 | Prompt-cache-aware credential switching | The credential broker, as specified, silently destroys the provider-side prefix cache | v1 | **done** |
| R5 | Prewarmed lane pool + reflink/CoW worktrees | The single biggest wall-clock win available; target lane-ready < 1s | v2 | **CoW warming done**, lane-ready latency published; the warm pool remains |
| R6 | Coordination state as an MCP server the lanes can actually read | Today it's a dashboard no agent can see; this makes it coordination | v3→pull to v2 | not started |
| R7 | Admission scheduler over RAM *and* quota headroom | Both inputs are already collected and thrown away | v2 | not started |
| R8 | Race mode: heterogeneous best-of-N with a verifier | Only Fluent can run N across providers *and* credentials | v3 | not started (R3 supplies its verifier) |
| R9 | Durable ordered mailbox between lanes | MAST 2.4/2.5; fire-and-forget handoffs lose information | v3 | not started |
| R10 | OTel `gen_ai` semantic conventions for local traces | Makes the Usage Observatory a debugger, at no cost to local-first | v2 | not started |
| R11 | Delta-injected, budgeted context packs per lane | Already specified in §11 — pull forward, because R6 makes it live | v2 | not started |
| R12 | Per-turn git checkpoints on a lane ref | Makes R2, R3 and R8 retries safe; makes "undo that turn" a button | v2 | not started |

---

## 1. What the field has already commoditized

Two maintained directories now track this category: `andyrewlee/awesome-agent-orchestrators`
(200+ entries, explicitly scoped to tools that *decide what an agent works on*) and
`Agent-Analytics/awesome-multi-agent-orchestrators`. Read end to end, they say something useful and
slightly uncomfortable.

**Commodity, present in dozens of tools:** worktree-per-agent isolation; a session/lane list with
live status; a built-in diff viewer and one-click merge; multi-provider support (Claude Code +
Codex + OpenCode + Pi is the standard quartet); phone/mobile access; a kanban board; a background
daemon so sessions survive the client. Conductor, Crystal/Nimbalyst, claude-squad, vibe-kanban,
Orca, Superset, Helmor, MonoCode (also Tauri), Paseo, Open Session, Lanes, Emdash, mux, and
roughly forty others all occupy this space. herdr owns the "daemon owns real PTYs, survives
detach" lane the spec already credits (§3).

**Not commodity — appearing in one or two tools each, and unevenly:**

- **Line-level ownership to prevent conflicts** — Zaivern Code is the only entry claiming it.
- **A shared code-knowledge graph across sessions to cut token use** — Tempest; Fletch serves a
  shared symbol and call-graph index to every agent over MCP.
- **Gating every step on tests or approval** — Fletch, ivy-tendril, YYLO (a "risk-based merge
  queue" with receipt-backed changes), Aperant (self-validating QA loop).
- **Automatic CI-failure and merge-conflict repair** — Untrivial's agent-orchestrator, Aperant.
- **Durable, FIFO, fail-closed inter-agent messaging** — Cyclops.
- **Sub-second sandbox checkpoint starts** — agentbox.
- **A single unified permission inbox across agents** — octomux.
- **A live quota gauge** — agent-squid.
- **Copy-on-write worktrees that keep the build cache warm** — `lane`.

**What no open tool combines, which is Fluent's actual territory (spec §3 was right):** a
credential broker with precedence and auto-revert, hardware/token intelligence, and a shared task
board with file claims — in one local-first app. The recommendations below are aimed at *not*
spending effort on the commodity column, and at turning the third list into one coherent system
rather than nine separate features.

---

## 2. What the research actually says

### 2.1 Topology: orchestrator-worker wins only when the task genuinely splits

Anthropic's production multi-agent research system uses a lead agent delegating to subagents and
reports ~90.2% improvement over a single-agent baseline on its internal evaluation — at roughly
**15× the tokens** of a chat interaction. The stated lesson is the important half: *architecture
follows task structure*; multi-agent systems win only when the task decomposes into genuinely
independent parallel threads, and the team spent weeks rewriting delegation prompts to stop agents
from spawning subagents for simple queries.

**For Fluent:** the human already does the decomposition when they open a lane, which sidesteps the
hardest part of that problem. But the 15× number is the honest price of parallelism and belongs in
the product — the Usage Observatory (screen 11) already separates main-agent from subagent
consumption, which is exactly the right instrument. It argues directly against any feature that
auto-spawns lanes on the user's behalf.

### 2.2 Failure is structural, not a model-quality problem

MAST (*Why Do Multi-Agent LLM Systems Fail?*, NeurIPS 2025) annotated 1,600+ traces across seven
popular multi-agent frameworks and produced 14 failure modes in three categories:

- **Specification & system design** — disobey task spec; disobey role spec; step repetition; loss
  of conversation history; unaware of termination conditions.
- **Inter-agent misalignment** — conversation reset; fail to ask for clarification; task
  derailment; **information withholding**; **ignored other agent's input**; reasoning-action
  mismatch.
- **Task verification** — premature termination; **no or incomplete verification**.

The paper's conclusion is that gains come from *refining system design*, not from better models or
prompts. Related work reports that uncoordinated multi-agent systems amplify errors up to 17×,
while centralized architectures with a validation bottleneck hold amplification near 4.4×.

**For Fluent:** every one of the bolded modes is an orchestrator-layer problem, which means they
are Fluent's to fix and are fixable without touching an agent turn. Information withholding and
ignored input are what R6 and R9 address. No-or-incomplete verification and premature termination
are what R3 addresses. "A validation bottleneck reduces error amplification ~4×" is, in product
terms, a merge queue (R2).

### 2.3 Integration is where parallel agents actually lose

This is the strongest empirical result found, and the most directly actionable.

**AgenticFlict** (ACM AIware '26) simulated merges for 107K+ AI-agent PRs from 59K+ repositories:

- **27.67%** exhibited textual merge conflicts (29K+ PRs, 336K+ conflict regions).
- Per conflicting PR: mean 4.36 conflicting files, mean 11.36 conflict regions, **mean 540 conflict
  lines**.
- By agent: Copilot 15.43%, Cursor 20.06%, Devin 23.04%, **Claude Code 26.86%**, **OpenAI Codex
  32.31%**.
- Follow-on work: **cross-agent pairs conflict at 41.7% vs 19.8% intra-agent**, non-overlapping
  95% CIs.

A separate finding in the same area: conflicts cluster on routing tables, configuration files and
component registries — files many features touch.

**For Fluent, read that last bullet again.** Screen 6 runs up to five lanes with *different
providers per lane*. That is precisely the cross-agent configuration with more than double the
conflict rate. Shipping the orchestration screen without an integration story ships the 41.7%
number to users as their experience of the product. Conversely: nobody else in the category is
structurally positioned to detect this, because nobody else is deliberately mixing providers *and*
already tracking per-lane file claims.

The field distinguishes three layers, and Fluent's claims system currently addresses none of them
well: **textual** conflicts (git sees them), **build** conflicts (merge cleanly, fail to compile —
one lane changes a signature, another calls the old one), and **semantic** conflicts (merge and
compile cleanly, logic contradicts). Existing semantic detectors are deliberately conservative and
work from declared dependencies, not full AST or behavioural analysis.

### 2.4 Verification is the highest-leverage compute, with one large caveat

Parallel test-time scaling — sample N trajectories, select with a verifier — is now standard at the
frontier. An LLM-as-verifier framework drawing a **heterogeneous** pool (N=3: one trajectory each
from Claude Opus 4.5, Gemini 3 Flash, MiniMax M2.5) scored **78.2% on SWE-Bench Verified**, above
every individual model in the pool (76.8% / 75.8% / 75.8%). Generative verifiers consistently beat
regressive (scoring-head) verifiers.

The caveat is sharp, and it changes the design: *All Smoke, No Alarm* finds **80.2% of
agent-generated test file patches contain weak or no explicit oracle signals** — the agent writes
test structure far more reliably than it writes the assertion that would catch a regression. Gates
that check "did the agent add tests" overestimate verification strength. PRs with strong oracle
signals merge at 59.7% vs 72.6% for weak-oracle PRs, i.e. the signal is real but not in the naïve
direction.

**For Fluent:** verify against *the repository's own pre-existing checks*, never against tests the
lane wrote in the same turn. And the heterogeneous-pool result is a gift: Fluent is the only tool
in the category that already models "which provider, on which credential" as a first-class object,
so running N across providers costs it almost nothing architecturally (R8).

### 2.5 Speed is a systems problem, not a model problem

Four independent threads, all of which point at the orchestrator rather than the agent.

**Prefix-cache locality is worth more than anything else on this list.** Prompt caching cuts cost
up to 90% and latency up to 85% on long prompts (vendor-reported, Anthropic). Google's Vertex AI
team reported that routing requests with shared prefixes to the server that already holds them
**doubled the prefix cache hit rate 35% → 70%, cut TTFT by 35% on context-heavy coding-agent
workloads, and improved P95 tail latency by 52%**. Cache hits require a byte-identical token prefix
from position 0. Production reports put well-engineered hit rates at 74–86%, achieved by separating
static from dynamic instructions and ordering prompt components by variability.

**This has a direct, unflattering implication for spec §9 that the spec does not currently name.**
The credential broker's entire job is to switch the credential mid-work when a limit is hit. A
credential switch changes the endpoint and the account — the warm prefix cache on the old path does
not follow. The feature that keeps the user working also throws away the 85%-latency /
90%-cost saving at the exact moment they are most sensitive to both. That is not an argument
against the broker; it is an argument for R4.

**Sandbox and workspace startup.** MicroVM work reports pre-warmed snapshot restore at ~150ms,
Firecracker snapshot CoW forking at ~0.8ms per fork (~265KB per sandbox, 100 forks in 101ms), and
full filesystem+memory+process restore from standby under 25ms; cold creation from template is
200–600ms. Fluent does not need microVMs — but the *pattern* (keep a warm pool, restore instead of
build) is exactly transferable to worktrees and agent processes.

**Copy-on-write workspaces.** On APFS, btrfs, XFS with `reflink=1`, bcachefs and recent ZFS,
reflink copies share extents: a second tree costs no new space **and arrives with a warm build
cache**. `lane` reports `cargo build` finishing in 0.21s in a fresh worktree because `target/` was
never missing. pnpm's documented git-worktree guidance gives each worktree its own `node_modules`
backed by one content-addressable store. The anti-pattern is explicit: symlinking a shared
`node_modules` breaks isolation and concurrent installs can corrupt it. One practitioner
recommendation matches the microVM pattern exactly: **maintain a fixed pool of pre-warmed worktree
slots rather than creating and destroying per task.**

**Disk is a real constraint.** A 2GB `node_modules` × 5 lanes is 10GB per project; "AI and worktrees
are filling our disks" is now its own genre of blog post. Reflink solves the cost and the warmth in
one move where the filesystem supports it, and Fluent already samples disk (`hardware-monitor.ts`).

### 2.6 The protocol layer moved while the spec was being written

Spec §7.5 assumes adapters detect state from "the CLI's own signals", with output pattern-matching
as the fallback for Codex, and §14 flags Codex parity as an open risk. That risk can be closed —
the answer exists on both sides now.

**ACP (Agent Client Protocol)** — JSON-RPC 2.0 over stdio, created by Zed, released August 2025.
25+ agents supported it as of March 2026; clients include Zed, JetBrains, Neovim and Emacs. The
stack is layered, not competitive: **MCP connects agents to tools, ACP connects agents to clients,
A2A connects agents to other agents.** The official `@agentclientprotocol/claude-agent-acp` adapter
(Apache-2.0) wraps the Claude Agent SDK and exposes: tool calls with permission requests, edit
review, TODO lists, **nested subagent transcripts**, interactive and background terminals, custom
slash commands, client MCP servers, plus opt-in extensions for **structured errors, recovery and
warnings (session failure)**, permission presentation with editable choices and durable effects,
and recommended model/effort defaults. Internally it maps ACP onto the Claude CLI's stream-json
control protocol.

**Claude Code's own headless surface** — `--output-format stream-json` / `--input-format
stream-json` with the control-request permission handshake, `--allowedTools`, `--permission-mode`,
and `--replay-user-messages` for an ordered transcript.

**Codex `app-server`** — a stateful JSON-RPC 2.0 backend over stdio (WebSocket experimental).
Methods include `thread/start`, `thread/resume`, **`thread/fork`**, `thread/rollback`,
`thread/list`, `turn/start`, **`turn/steer`** (append input mid-flight), `turn/interrupt`,
`review/start`, `mcpServer/tool/call`, `account/read`, `config/read`. Notifications stream
`turn/started`/`turn/completed` and `item/*` lifecycle with suppressible high-volume delta
channels. Codex also ships `hooks.json` (`SessionStart`, `PreToolUse`, `PermissionRequest`,
`PostToolUse`, `UserPromptSubmit`, `Stop`; experimental, off by default, no Windows, first shipped
v0.114 / March 2026) and subagent templates at `~/.codex/agents/*.toml`.

**Codex rate limits, specifically** — `account/rateLimits/read` and a `usage.rate_limits` event
return primary and secondary windows with `usedPercent`, `windowDurationMins` and `resetsAt`. Two
documented gotchas: calling too early after `initialize` can return empty data, and the payload is
a **sparse rolling update** — absent fields must be merged into the last-known snapshot, never
treated as "cleared". (One community write-up of the app-server surface does *not* list token
counts or rate-limit events; the two sources disagree and this needs a hands-on check against the
installed Codex version before the adapter depends on it — exactly the caution spec §14 asked for.)

**For Fluent:** this is near-perfect parity with the Claude Code hook fields `hook-relay.ts`
already consumes. The Codex adapter does not need output pattern-matching. Spec §14's first open
risk closes — with a verification step, not an assumption.

---

## 3. Where the current implementation stands

Read directly from `src/` rather than from the spec, because the code is ahead of the spec in
several places.

**Already real and good:** `daemon.ts` + `session-manager.ts` (PTY lifecycle, `sessions.subscribe`
— the streaming gap §7.4 flagged is closed), `credential-broker.ts`, `coordination.ts` (tasks,
claims, decisions, handoffs, atomic persist), `worktree-manager.ts` (detached worktrees beside the
project), `hook-relay.ts` + `hooks-config.ts` (additive-only merge into `.claude/settings.json`,
never overwrites a user hook or status line — this is the right instinct), `usage-monitor.ts`
(context %, cost, **cache hit ratio**, 5h and 7d percentages and reset times), `spend-tracker.ts`,
`resource-monitor-client.ts`, `remote-manager.ts`.

**The gaps that matter, against §2:**

1. **Codex is a bare `spawn('codex', [])`.** `providers.ts` gives it no arguments and no telemetry
   path. Everything the usage monitor knows, it knows about Claude only — `UsageSnapshot` is
   literally typed `provider: 'claude'`. → R1.
2. **Coordination state is write-only from the agents' perspective.** `CoordinationManager` is a
   well-built store that no agent can read or write; only the app can. A task board the agents
   cannot see is a dashboard, not coordination. → R6.
3. **Claims are exact-path, permanent, and unenforced.** `claim()` compares `claim.path === path`,
   so `src/foo.ts` and `src/` never conflict; there is no lease or expiry, so a dead lane's claims
   block forever; and a conflict is *reported* but the claim is silently not recorded, which means
   the caller must check `conflict` or it looks like success. → R2.
4. **Nothing connects a worktree to a merge.** `WorktreeManager` creates and removes. There is no
   rebase, no verification, no queue, no integration path at all. Against §2.3's numbers this is
   the largest product risk in the repo. → R2, R3, R12.
5. **No prewarm, no CoW.** Every lane pays full `git worktree add` plus a cold dependency install
   and a cold build cache. → R5.
6. **Quota data is collected and discarded.** `fiveHourPercent`/`sevenDayPercent`/`resetsAt` feed a
   chart; nothing schedules against them. → R7.
7. **`cacheHitRatio` is collected and shown, but never used as an input to a decision** — including
   the one decision that destroys it. → R4.

---

## 4. Recommendations

Each is framed against the one rule (spec §1): orchestrate, don't rebuild. Where one brushes a
non-goal, that is called out rather than glossed.

### R1 — Give every provider a structured control channel, and keep the PTY for rendering
**Phase: v1. Unblocks: R3, R6, R7, R8, R9, R10.**

Run each lane with two channels: the PTY exactly as today (it is what screen 3 renders, and it
preserves "the CLI as the user would run it"), plus a structured channel for events, permissions,
usage and control.

- **Claude Code:** keep the hooks relay (it works and it is the least invasive thing in the repo),
  and add ACP via `@agentclientprotocol/claude-agent-acp` for lanes that want structured tool
  calls, permission requests, edit review and nested subagent transcripts.
- **Codex:** add `codex app-server` as the adapter's control plane — `thread/start`, `turn/start`,
  `turn/steer`, `turn/interrupt`, `account/rateLimits/read`, `usage.rate_limits` — plus `hooks.json`
  where the installed version supports it.

Then generalize `UsageSnapshot` off `provider: 'claude'` and normalize both providers' quota
reporting into one shape (`usedPercent` / `windowMinutes` / `resetsAt`), merging sparse updates
rather than overwriting.

*Why:* this is the single highest-leverage change because six other recommendations need a channel
that isn't terminal text. It also closes spec §14's Codex risk with a documented mechanism instead
of a fallback. *Cost:* one new dependency (Apache-2.0) and real work in the Codex adapter.
*Caution:* verify `usage.rate_limits` hands-on before depending on it — the sources disagree
(§2.6). *Fit:* strictly orchestration; it reads the CLIs' own protocols and never reimplements a
turn. `turn/steer` and `turn/interrupt` are the CLI's own controls, used as intended.

### R2 — Make integration a product surface: predictive claims and a serialized merge queue
**Phase: v2 foundation, v3 full. This is the recommendation that would make Fluent best-in-class.**

Four parts, in order of cost:

1. **Fix claims first (cheap, do it now).** Path-prefix and glob overlap, not string equality. A
   lease with a TTL that a live lane renews, so a crashed lane releases automatically. Make the
   conflict path explicit in the return type so a caller cannot mistake a refused claim for a
   granted one.
2. **Make claims predictive, not just declarative.** A claim today requires an agent to announce
   intent, which requires R6. Meanwhile the daemon can derive de-facto claims for free by watching
   each worktree's own diff (`sessions.diff` already exists) and raising overlap the moment two
   lanes' *actual* hunks intersect. Weight the known hotspots — routing tables, config files,
   component registries (§2.3).
3. **Serialize the merge.** One integration queue per project: rebase the lane on current main, run
   the repo's checks (R3), merge, then release the next lane onto the new main. This is the
   "centralized architecture with a validation bottleneck" that holds error amplification near 4.4×
   instead of 17× (§2.2), expressed as a UI.
4. **Predict beyond text.** Textual overlap is free from git. Build conflicts (changed signature vs.
   old call site) are catchable conservatively from declared dependencies and a symbol index —
   Fletch already serves a shared symbol and call-graph index to its agents over MCP as prior art.
   Semantic conflicts stay out of scope; say so plainly rather than implying detection.

*Why:* §2.3. Fluent's headline screen is the configuration with the highest measured conflict rate
in the literature. *Fit:* a merge queue is pure orchestration. *Guardrail:* per principle §2.3,
conflicts are surfaced and resolved with the user in the loop — do **not** ship silent LLM
auto-resolution. Offering to hand a conflict to a lane *as a visible, approved task* is consistent
with the principles; resolving it behind the user's back is not.

### R3 — Gate "done" on the repository's own checks, never on the agent's word
**Phase: v1 (the single-lane version is nearly free).**

A lane reports done → the daemon runs the project's own verification command in that worktree →
the lane's status becomes `verified` or `failed`, with output attached. The status pill on screens
4 and 6 shows the *verified* state, not the agent's self-report.

Discover the command the way the ecosystem already does (package scripts, Makefile target,
`.claude/settings.json`, an explicit per-project setting), and let the user override it. Cache the
result per commit so a re-check is free.

*Why:* MAST's third category is "premature termination" and "no or incomplete verification" — the
failures that make a parallel fleet *slower* than one agent, because the user reviews work that was
never going to pass. *The caveat is load-bearing:* verify against pre-existing repo checks. 80.2% of
agent-authored test patches carry weak or no oracle (§2.4), so "the lane added tests and they pass"
is close to no signal at all. *Fit:* running the project's own test command is orchestration in its
purest form.

### R4 — Make the credential broker prompt-cache aware
**Phase: v1, alongside the broker itself.**

The broker as specified (§9) switches credentials on a limit hit. Add cache locality as an input:

- **Switch at a turn boundary, never mid-turn.** The CLI holds the turn; wait for it.
- **Prefer switching a lane that is about to start fresh context** over one deep into a long
  session, when several lanes are eligible.
- **Put the cost in the prompt.** The "always ask" dialog already says *"resets in 47m — switch and
  keep going?"*. It should also say what the switch costs: `cacheHitRatio` is already in
  `usage-monitor.ts`, so the dialog can say the warm cache will be lost and roughly what that means
  for the next turn's latency and spend.
- **On auto-revert, expect a cold start** and don't attribute the resulting latency spike to the
  machine on screen 5.
- **Keep prefix stability as an explicit constraint** on anything Fluent injects into a session
  (R11): static coordination content first, volatile content last, byte-stable ordering. A prefix
  cache requires a byte-identical prefix from position 0 — reordering an injected task board
  invalidates everything after it.

*Why:* up to 90% cost and 85% latency on long prompts, 35% TTFT and 52% P95 improvements from
routing for cache locality (§2.5). A credential broker that ignores this is optimizing the bill
while paying for it in wall-clock. *Fit:* this is Fluent deciding locally which credential to use —
exactly what §9 already reserves to Fluent — with one more input.

### R5 — Prewarmed lane pool with copy-on-write worktrees
**Phase: v2. This is the "fastest in the world" recommendation.**

- **Reflink the workspace where the filesystem allows it** (APFS, btrfs, XFS `reflink=1`,
  bcachefs, recent ZFS): clone git-ignored paths by reference so `node_modules/`, `target/`,
  `.next/`, `.venv` arrive already warm at near-zero space cost. Fall back to a plain worktree
  everywhere else — this must degrade, not fail. `lane` is the reference implementation of this
  idea; pnpm's worktree guidance is the reference for the package-manager half.
- **Never symlink a shared `node_modules`.** Documented corruption risk under concurrent installs,
  and it breaks the isolation the worktree exists for.
- **Keep a pool of N pre-created, pre-warmed worktree slots** per project, refilled in the
  background, so "new lane" is a hand-off from the pool rather than a `git worktree add` plus a
  cold install. This is the same pattern the microVM literature converged on (pre-warmed snapshot
  restore at ~150ms vs 200–600ms cold create) applied at the filesystem layer.
- **Pre-spawn the agent process** in a pooled slot so the first keystroke lands on a running CLI.
- **Publish the number.** Lane-ready latency, p50 and p95, on screen 5's hardware grid. Nobody in
  §1's list of 200 tools publishes this; measuring it is itself a differentiator, and it keeps the
  claim honest.
- **Tie the pool to the disk sampling already in `hardware-monitor.ts`** — shrink the pool under
  disk pressure rather than filling the user's disk, which is a known failure mode of this whole
  category (§2.5).

### R6 — Expose coordination state to the lanes as an MCP server
**Phase: specced as v3 — pull the read path into v2.**

`CoordinationManager` already holds tasks, claims, decisions and handoffs. Serve it to each lane as
a small MCP server (both CLIs take client MCP servers; `design-tool-manager.ts` already installs
MCP config, so the plumbing exists):

- `fluent_status` — **one combined query**: my tasks + open claims + conflicts affecting me +
  pending handoffs, as §11 requires.
- `fluent_claim(paths[])` / `fluent_release(paths[])` — turns R2's derived claims into declared
  intent, which is strictly better because it is known *before* the edit.
- `fluent_note(summary)` — writes the decisions feed.
- `fluent_handoff(to, summary)` — proposes a handoff; still requires the user's visible approval
  per §11.

*Why:* MAST 2.4 (information withholding) and 2.5 (ignored other agent's input) are the two modes a
shared, readable state store directly prevents. *Fit:* MCP is the tool layer of the stack (§2.6) and
both CLIs consume it natively — this is using the CLIs' own extension point, not wrapping them.
*Guardrail:* per §11, an agent *asking* for state is fine; injecting state into every turn is how
the token cost gets away from you (R11).

### R7 — Schedule admission on hardware *and* quota headroom
**Phase: v2.**

Spec §10 says the hardware advisory needs an actual heuristic. Propose a two-input admission check,
still advisory per principle §2.4:

- **Memory:** maintain a rolling per-provider RSS estimate from `resource-monitor-client.ts` (real
  observed data beats a guessed constant), and warn when `(free - reserve) / p90_rss_per_lane` is
  below the requested lane count. Start with a fixed OS reserve and tune from telemetry.
- **Quota:** the lane's credential's `usedPercent` and `resetsAt` — both providers now report this
  (R1). Starting a fifth lane on a credential at 94% of a 5-hour window is a worse failure than
  starting it on a busy CPU, because it fails *after* the user has invested attention.
- **Queue rather than block.** A lane that can't start now starts automatically when headroom or
  quota returns — which is what makes this advisory rather than enforcement.

### R8 — Race mode: heterogeneous best-of-N with a verifier
**Phase: v3. Opt-in, never default.**

For a well-specified task, run the same prompt in N lanes across *different providers/models/
credentials*, then rank by the R3 verification result, then by diff size, and present them
side by side for the user to pick. Codex's `thread/fork` makes the same-provider variant cheap.

*Why:* a heterogeneous N=3 pool beat every model in it on SWE-Bench Verified (78.2% vs 76.8/75.8/
75.8) (§2.4), and Fluent is the only tool in §1's list whose data model already knows how to run N
across providers and credentials. *Guardrails:* the token cost is the whole story — show the
multiplier before the run (Anthropic's 15× is the honest reference point), cap N, and route the
losers' spend into screen 11 so the trade is visible. Make the verifier the repo's own checks, not
a model judging a model, at least to start.

### R9 — Durable, ordered mailbox between lanes
**Phase: v3.**

Handoffs today are records in a JSON file; nothing delivers them. Give each lane a FIFO mailbox
that survives daemon restart and delivers into the lane's next turn via R1's structured channel.
Cyclops is the prior art (durable mailbox, FIFO per recipient, fail-closed). Keep every delivery
visible in the coordination feed per §2.3 — a message an agent received that the user cannot see is
exactly the hidden coordination the principles forbid.

### R10 — Local traces on the OTel `gen_ai` semantic conventions
**Phase: v2.**

Record each lane's turns as spans using the GenAI semantic conventions — `invoke_agent` parent,
`chat` and `execute_tool` children, `gen_ai.request.model`, `gen_ai.usage.input_tokens` /
`output_tokens`, `gen_ai.response.finish_reasons`. R1's structured channel emits exactly these
events, so the cost is mapping, not collection.

Keep it local-first and keep screen 11's "local only · no remote write · no cloud export" panel
literally true — but using the standard schema means a user who *wants* to point their own
collector at it can, without Fluent building an export product. The conventions are still marked
experimental as of March 2026, so pin and expect churn.

### R11 — Budgeted, delta-injected context packs
**Phase: pull from v3 to v2, because R6 makes it live.**

Spec §11 already specifies this well (minimal fields, deltas not snapshots, TOON-style tabular
rows, one combined query, explicit empty states). Two additions from this research:

- **A hard per-lane injection budget**, shown in the UI. Coordination state that grows without
  bound is how a coordination feature becomes a token-cost feature.
- **Byte-stable prefix ordering** (see R4): static content first, volatile last. This is not a
  style preference — it is the difference between a cache hit and a cache miss on every subsequent
  turn.

### R12 — Per-turn git checkpoints on a lane ref
**Phase: v2.**

On each turn boundary (available from R1), commit the worktree to a lane-private ref. Costs a
commit object; buys: "undo that turn" as a button, safe retries for R2's merge queue and R8's
races, a real diff-per-turn for review, and a recovery path when a lane goes off the rails — which
in the MAST taxonomy is a whole category (task derailment, step repetition). Codex's own
`thread/rollback` is the conversational half of the same idea; this is the filesystem half.

---

## 5. What the research says *not* to do

- **Don't build a swarm framework, roles, or an auto-decomposing lead agent.** MAST's failures
  concentrate in exactly that machinery, and Anthropic's own lesson is that delegation prompting
  took months to stop misfiring. The human decomposes by opening a lane; that is a feature.
- **Don't auto-spawn lanes.** 15× tokens (§2.1), and it violates §2.3's "coordination is
  inspectable, never hidden".
- **Don't silently auto-resolve merge conflicts with a model.** Surface, propose, let the user
  approve. Two tools in §1 advertise automatic conflict resolution; that is a different product
  with a different risk appetite.
- **Don't adopt A2A.** It is the cross-organization agent layer (150+ orgs, v1.0 April 2026);
  lanes on one machine coordinating through one daemon is not the problem it solves. MCP (R6) and
  ACP (R1) are the two layers Fluent actually sits on.
- **Don't make containers the default isolation.** Sculptor does per-agent Docker and pays for it
  in startup and resource cost; worktrees are cheaper and native. Offer container/VM isolation as
  an opt-in for untrusted work, which is also where §8's permission dials belong.
- **Don't gate on agent-written tests** (§2.4).
- **Don't build a hosted anything** — unchanged from §13, and nothing in this research argues
  otherwise.

---

## 6. Sequencing against the spec's phasing

| Spec phase | Add from this report |
|---|---|
| **v1** | R1 (structured channel; closes §14's Codex risk) · R3 (verification gate, single-lane) · R4 (cache-aware broker) |
| **v2** | R5 (prewarm + CoW; the speed story) · R2 parts 1–3 (claims fix, derived claims, merge queue) · R7 (admission scheduler) · R10 (traces) · R11 (context packs) · R12 (checkpoints) |
| **v3** | R6 (coordination MCP — pull the read path to v2 if the orchestrator screen slips) · R2 part 4 (build-conflict prediction) · R8 (race mode) · R9 (mailbox) |

**Two open questions this research did not resolve**, both still live from spec §14: what
"OpenRouter" means as a product concept, and the hardware-advisory thresholds (R7 proposes a shape,
not tuned numbers). One question it *adds*: whether `usage.rate_limits` is present in the Codex
version Fluent targets — check before the adapter leans on it.

**The metric to commit to.** "Fastest in the world" needs a definition or it is marketing. Propose
two, both measurable locally and both surfaced in the product: **lane-ready latency** (p50/p95 from
"new lane" to a warm, working agent — R5) and **time to verified merge** (p50 from task accepted to
merged-and-green — R2 + R3). No tool in the §1 directory publishes either. Publishing them, and
being honest when they regress, is a more durable position than any feature on this list.

---

## 7. Sources

**Research**
- [Why Do Multi-Agent LLM Systems Fail? (MAST)](https://arxiv.org/abs/2503.13657) · [NeurIPS 2025 poster](https://neurips.cc/virtual/2025/poster/121528) · [repo](https://github.com/multi-agent-systems-failure-taxonomy/MAST) · [MAST-Data](https://huggingface.co/datasets/mcemri/MAST-Data)
- [AgenticFlict: merge conflicts in AI coding agent PRs](https://arxiv.org/abs/2604.03551) · [ACM](https://dl.acm.org/doi/10.1145/3805760.3814923) · [dataset repo](https://github.com/unlv-evol/AgenticFlict)
- [AI Agent Pull Requests on GitHub: Frequency, Structure, and Merge Conflict Rates](https://arxiv.org/pdf/2607.04697)
- [All Smoke, No Alarm: Oracle Signals in Agent-Authored Test Code](https://arxiv.org/html/2606.18168v1)
- [LLM-as-a-Verifier](https://arxiv.org/pdf/2607.05391) · [R2E-Gym: hybrid verifiers](https://arxiv.org/pdf/2504.07164) · [Agentic Rubrics as Contextual Verifiers](https://arxiv.org/pdf/2601.04171)
- [Where Do AI Coding Agents Fail? Failed Agentic PRs](https://arxiv.org/pdf/2601.15195)
- [A survey of agent interoperability protocols (MCP/ACP/A2A/ANP)](https://arxiv.org/pdf/2505.02279)
- [DeltaBox: millisecond sandbox checkpoint/rollback](https://arxiv.org/pdf/2605.22781)
- Anthropic, *How we built our multi-agent research system* — via [ZenML LLMOps database](https://www.zenml.io/llmops-database/building-a-multi-agent-research-system-for-complex-information-tasks) and [ByteByteGo](https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent) (anthropic.com unreachable from this environment)

**Protocols and provider surfaces**
- [Agent Client Protocol](https://zed.dev/acp) · [ACP vs MCP vs A2A](https://www.morphllm.com/comparisons/acp-vs-mcp-vs-a2a)
- [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) (Apache-2.0)
- [Building on codex app-server: JSON-RPC interface guide](https://gist.github.com/oneryalcin/ee2c27e2d8aa040da8fbe7eebcc2ecea) · [Codex App Server docs](https://learn.chatgpt.com/docs/app-server)
- [Codex CLI hooks guide](https://codex.danielvaughan.com/2026/04/15/codex-cli-hooks-complete-guide-events-policy-patterns/) · [`account/rateLimits/read`](https://iaplabs.itch.io/codexfuse/devlog/1655686/how-to-check-codex-usage-limits-with-app-server-accountratelimitsread)
- [Claude Code subagents and orchestration](https://hidekazu-konishi.com/entry/claude_code_subagents_and_orchestration_guide.html) · [Claude Agent SDK guide](https://hidekazu-konishi.com/entry/claude_agent_sdk_complete_guide.html)
- [OpenTelemetry GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) · [Inside the LLM Call](https://opentelemetry.io/blog/2026/genai-observability/)

**Performance**
- [Prompt caching in practice: 7% → 74% hit rate](https://www.digitalocean.com/community/conceptual-articles/prompt-caching-in-practice-hit-rate)
- [Snapshots, copy-on-write, and the economics of agent sandboxes](https://builders.cortex.io/blog/sandboxing-agents-part-2/) · [Firecracker snapshots in 28ms](https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k) · [State of MicroVM isolation in 2026](https://emirb.github.io/blog/microvm-2026/)
- [pnpm + git worktrees](https://pnpm.io/git-worktrees) · [lane — CoW worktrees](https://lane.lukeed.com/) · [AI and worktrees are filling our disks](https://kunobi.com/blog/kache-storage-worktrees)

**Landscape**
- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) · [awesome-multi-agent-orchestrators](https://github.com/Agent-Analytics/awesome-multi-agent-orchestrators) / [Open Orchestrators](https://openorchestrators.org/)
- Referenced entries: [herdr](https://github.com/herdrdev/herdr) · [t3code](https://github.com/pingdotgg/t3code) · [Fletch](https://github.com/fwdai/fletch) · [Cyclops](https://github.com/cyclops-team/cyclops) · [YYLO](https://github.com/yylo-dev/yylo) · [Tempest](https://github.com/tempestai-dev/tempest) · [agentbox](https://github.com/madarco/agentbox) · [octomux](https://github.com/ShreyPaharia/octomux) · [Zaivern Code](https://github.com/tacyan/zaivern-code) · [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) · [claude-squad](https://github.com/smtg-ai/claude-squad) · [Helmor](https://github.com/dohooo/helmor)
