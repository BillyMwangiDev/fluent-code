# Fluent Code — end-to-end design spec

Status: brainstorming complete, pending your review before we move to an implementation plan.
Companion docs: [`AGENTS.md`](../../../AGENTS.md) (product/brand, kept in sync with this spec),
[`CLAUDE.md`](../../../CLAUDE.md) (condensed engineering reference).

## 1. What this is

Fluent Code is an open-source desktop application that orchestrates AI coding-agent CLIs —
Claude Code and Codex today, extensible to more — from one place. It runs multiple concurrent
sessions, manages which credential (subscription, platform API credits, or API key) each one
uses and falls back sensibly when one is rate-limited, coordinates several agents working on the
same project at once, and shows hardware and token usage so a developer can tell what their
machine and their bill are actually doing.

**It is not a coding agent.** Claude Code and Codex already have a harness — system prompt,
tool-calling loop, context management, sandboxing. Fluent Code runs them as real, unmodified
processes and never re-implements what happens inside a turn. Everything in this document is
about the layer *around* those processes: which one runs, with which credential, how many at
once, how they share a project, and what the user can see about all of it.

## 2. Product principles

1. **Orchestrate, don't rebuild.** If a feature requires understanding or rewriting what a
   provider CLI does internally, it's out of scope. Trigger the CLI's own tools (`/compact`,
   login flows, hooks) rather than reimplementing them.
2. **Every credential talks directly to its real provider.** No Fluent-run backend, no billing,
   no proxying of model calls, ever. Fluent decides *locally* which already-connected credential
   to use; it never stands between the user and the provider's own systems.
3. **Coordination is inspectable, never hidden.** Task claims, conflicts, handoffs, and
   credential switches are always visible, user-controlled events — not automatic magic.
4. **Advisory, not enforcement, for anything about resource limits.** Fluent recommends; it
   doesn't block. Per-agent resource use is too variable to gate hard reliably yet.
5. **Local-first.** Usage/token telemetry lives on the user's machine by default (see §10, §12 —
   the Usage Observatory screen explicitly shows "local only · no cloud export").
6. **Lean over familiar-but-heavy.** Every dependency choice in this doc was made by asking "does
   this justify its weight," not "what's the standard tool" — see §7's Tauri-vs-Electron reasoning
   and §3's herdr/T3 Code comparisons for the pattern.

## 3. Prior art & positioning

Two existing projects sit close to this idea. Both were researched directly (repo contents,
docs, stars/license verified via GitHub's API, not secondary summaries) before deciding not to
build on either.

**T3 Code** (`pingdotgg/t3code`, MIT) — "an agent harness control surface." A server owns an
event-sourced orchestration engine with per-provider protocol adapters (`effect-acp`,
`effect-codex-app-server`) that translate each CLI's internals into T3's own conversation UI,
rendered by Electron desktop, web, and native mobile clients. This is real, sophisticated
engineering — and it exists specifically to parse a CLI's internals into someone else's UI, which
Fluent Code doesn't need: we show the CLI's own behavior, not a reimplementation of it. Its
weight (event sourcing, three additional client platforms) buys capability Fluent has no use for.

**herdr** (`herdrdev/herdr`, Apache-2.0, ~38,000 stars, ~2,800 forks, active) — "the runtime your
coding agents live on." A background Rust server owns real PTY panes, survives detach/SSH-loss,
supports multi-machine remote, and detects per-agent state (working/blocked/done/idle) for 15+
CLIs including Claude Code and Codex. It has a plugin marketplace (a code-review sidebar, a file
viewer, a native macOS console, phone/Telegram remote control) and an agent-native socket API.
This is excellent, validated prior art for the exact "daemon owns real PTY sessions, client
attaches" shape `fluentd` uses. It does **not** have a credential broker, hardware/token
intelligence, or a shared task board/file-claims system — confirmed directly against its own
docs. Those are Fluent's actual unique territory.

**Why not build on either:** T3 Code's shape (event-sourced multi-client sync) solves a problem
we don't have. herdr's shape (own the user's literal terminal/TTY) stopped being fully compatible
with this product the moment screen 8 required a real embedded webview (§7.1) — herdr is
terminal-native by design; Fluent Code is now a windowed app that *looks* terminal-native. Both
remain valuable reference material, not dependencies.

## 4. Brand & visual system

Full detail in `AGENTS.md`; summarized here for completeness.

- **Mark:** four radius-6 circles in a 26×26 box at `(8,8)`, `(18,8)`, `(8,18)`, `(18,18)`.
  Top-left/top-right/bottom-left Canvas `#f5f4ee`; bottom-right Coral `#d97757` — always
  bottom-right, never recolored or moved.
- **Wordmark:** lowercase `fluent` + `code`, Archivo Bold, tight tracking, headlines/wordmark only.
- **Palette:** Canvas `#f5f4ee` · Surface `#faf9f5` · Ink `#1f1e1d` · Ink 2 `#4a4843` · Ink 3
  `#7a7869` · Border `#e3e1d9` · Coral `#d97757` · Coral Hover `#c15f3c` · Coral Tint `#f6e6de`.
  Coral is accent/action/warning only — never a large field, never an ordinary data series.
- **Type:** Archivo for display/headlines; IBM Plex Mono for terminal chrome, code, metadata,
  dense data UI — mono dominates the actual interface, this is a developer tool.
  **Voice:** plain, practical, encouraging. No "revolutionary/seamless/10x."
- **Radii:** cards 12px, buttons 8px, chips 999px.
- **Density:** dark, monospace-forward, dense information design — compact cards, tables,
  sparklines, line/area charts, clear state labels. No chat bubbles, no oversized illustrations.

## 5. Product vocabulary

- **Provider** — Claude Code or Codex today; OpenRouter as a billing/routing path for one of
  them (see §14 for the open question about whether "OpenRouter" ever means a genuinely
  model-agnostic third provider).
- **Account** — the subscription, platform-credits, or API-key identity used by a provider.
- **Credential chain** — a provider's ordered precedence across those three, with automatic
  fallback and revert on a usage-limit hit.
- **Session / thread** — an in-progress agent conversation and its terminal context.
- **Agent lane** — one concurrent terminal session in the orchestration view.
- **File claim** — a non-destructive reservation signaling an agent intends to edit a file.
- **Coordination** — the shared task board, project memory, decisions, handoffs, reviews, and
  conflict resolution across agent lanes.

## 6. The twelve screens

Source of truth: `design/pen/fluent-code.pen`, exported to `design/previews/*.png` (filenames are
Pen frame IDs; see `design/README.md` for the mapping). Descriptions below are from direct
inspection of every exported screen.

1. **Launch splash** (`pRRkh`) — mark + wordmark, version, active-provider badges
   (`claude-code · work`, `codex · personal`), a rule, then the prompt line. Full splash on every
   launch (the chosen direction from early exploration).
2. **Provider auth** (`VjRP6`) — three cards (Claude Code, Codex, OpenRouter), each offering CLI
   login and API key as equally-weighted options, OpenRouter additionally offering a preset-config
   path. "Skip for now" always available.
3. **Active session** (`RkZKx`) — streaming agent output, inline bash/edit tool calls shown as
   real diffs, and a risky-action approval box (approve/deny/edit) — the pattern every
   destructive-action confirmation in the product follows.
4. **Session list** (`rYrrq`) — a table of threads: provider, account, status pill
   (active/paused/done/error), token count, last-active time, aggregate footer stats.
5. **Remote server** (`AFx7k`) — a connected-hosts sidebar plus, for the selected host: a live
   terminal pane, a usage/model panel (token flow, budget, context-window), and a dense hardware
   grid (CPU, load, memory+pressure, disk+I/O, network, GPU/VRAM, temp/power, PSI, top processes)
   and software/services panel (OS/runtime versions, agent adapter versions, active ports,
   repo/container state).
6. **Parallel orchestration** (`VdcJ5`) — up to five agent lanes running concurrently (different
   providers/models per lane), plus a coordination column: shared task board, file claims with
   overlap-conflict detection, a memory/decisions feed, and pending handoff requests between lanes.
7. **Design workspace** (`L4V1al`) — repo-native design tasks bound to real files/components, an
   exact-token inspector, a component tree, a compact live preview, and a task pipeline
   (design → build → preview → visual-check) with shared-memory claims between design/build/QA
   agents.
8. **Preview & visual check** (`NKnBc`) — **the screen that settles the architecture question in
   §7.1.** Docks an actual rendered preview of the user's own web app (real DOM, hydrated, with
   reload/inspect controls) next to a runtime-checks panel (route match, env loaded, DOM node
   count, a11y pass, visual delta) and an "agent return map" showing which DOM regions map to
   which source components, plus a design-vs-running-app visual diff strip with a "return to
   agents" action.
9. **New session** (`q8LpEE`) — provider picker (with a visible "+" affordance for more
   providers), account picker showing all three credential-chain entries with the default
   pre-selected, working-directory field, optional starting task, keyboard-first (`tab`/`enter`/
   `esc`).
10. **Claude Code credentials** (`htKKf`) — the precedence-chain editor: drag-to-reorder rows for
    Subscription/Platform API Credits/API Key, each showing connection state and an "active now"
    tag on the top entry, plus a three-way fallback-behavior control (always ask / always switch /
    never switch) with a plain-language summary underneath.
11. **Usage observatory** (`hNqHb`) — local-first telemetry: total/input/output/cache tokens,
    spend, live burn rate, quota/reset countdown; a multi-series token-flow chart per
    provider/model; a model×agent breakdown table (explicitly separating main-agent and subagent
    consumption); active-sessions table; and an explicit "local only · no remote write · no cloud
    export" status panel.
12. **Themes & appearance** (`qLHqC`) — the two-level theme contract in UI form: Level 1 picks
    appearance mode (System/Light/Dark — "System is a resolver, not a theme"), Level 2 picks a
    theme bundle filtered to that mode, and a live preview panel shows the complete bundle
    (semantic colors, terminal ANSI mapping, syntax colors, density/font) applied to a real
    session.

## 7. System architecture

```
fluent    the app the user runs — a Tauri desktop app
fluentd   a local background daemon; owns everything that must outlive one app attach
providers/*  one adapter per supported CLI (claude, codex, openrouter-as-claude-preset, ...)
```

### 7.1 Why a windowed app, and why Tauri specifically

The original direction was a pure terminal-native app (Ink, no windowing at all) — deliberately
chosen to stay in herdr's lean, TTY-native lane. Screen 8 overturned that: it docks a live,
arbitrary, hydrated web-app preview inside the window. There is no way to draw someone's real
CSS/fonts/layout with terminal characters, so a real embedded webview became a hard requirement,
not a nice-to-have.

Given that requirement, the choice is Electron vs. Tauri vs. something else — not
"terminal vs. GUI" anymore. Electron is the proven, familiar path (VS Code's own integrated
terminal is xterm.js + node-pty inside Electron). Tauri gives the identical capability — real
window, real embedded webview, real terminal panes — using the OS's native webview instead of
bundling Chromium:

| | Electron | Tauri |
|---|---|---|
| Bundle size | ~120–200 MB | ~3–10 MB |
| Idle RAM | ~150–400 MB | ~40–80 MB |
| Cold start | ~1.4s | ~0.4s |
| Terminal-in-app | xterm.js + node-pty | xterm.js + Rust PTY, via `tauri-plugin-pty` (an established plugin) or manual `portable-pty` |

Sources: [rustify.rs](https://rustify.rs/articles/rust-tauri-vs-electron-2026),
[tech-insider.org](https://tech-insider.org/tauri-vs-electron-2026/),
[pkgpulse.com](https://www.pkgpulse.com/guides/electron-vs-tauri-2026),
[tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty).

**The cost, named plainly:** `fluent` is its own window. It cannot be attached to over a bare SSH
session the way tmux/herdr/an Ink app can. Remote access (screen 5) means the local `fluent` app
talking over the network to a headless `fluentd` on the remote box — which was already the plan
(see 7.2) — not "ssh in and the app just runs there." This is a deliberate, understood tradeoff,
not an oversight.

**Note on `fluentd`'s own PTY handling:** the daemon does not need `portable-pty` or any Rust PTY
library — it already spawns sessions with Node's `node-pty` (see 7.4) and returns captured output
as plain text over RPC. The Tauri app's job is only to *render* that text with xterm.js and send
keystrokes back; it does not spawn PTYs itself. This keeps the already-working daemon code
untouched by the client-technology change.

### 7.2 `fluentd` — the daemon

Modeled on the tmux-server idea: sessions live in the daemon, not the client. Closing the app (or
losing SSH to a remote box) never kills a running agent; a remote machine's `fluentd` is what
screen 5 actually connects to.

Owns:
- **PTY session lifecycle** — spawn/attach/detach/kill/list, one real PTY per session, running the
  provider CLI exactly as it would run standalone.
- **The credential broker** (§9).
- **The hardware monitor** (§10).
- **The token/usage tracker** (§10, feeds screen 11).
- **Coordination state** (§11) — shared task board, file claims, conflict detection, memory/
  decisions log, handoff requests. Per-project, shared across every lane on that project, always
  inspectable.

Talks newline-delimited JSON-RPC over a Unix socket. This is already client-agnostic — the Tauri
app is just another RPC client, the same relationship the original Ink prototype had.

### 7.3 `fluent` — the app

A Tauri app. `xterm.js` renders terminal panes from text `fluentd` already captures via
`node-pty`. The live-preview screen (8) is a real Tauri webview pointed at the project's local
dev-server URL. Every other screen is ordinary HTML/CSS/JS styled to the exact brand tokens in
§4 — a webview renders the already-designed dense, dark, monospace-forward look *more* faithfully
than ANSI art would (real fonts, real anti-aliasing, real mouse/scroll), not as a downgrade from
it.

### 7.4 Current implementation status

A prototype already exists in `src/` (Ink + `node-pty`, ~650 lines total):

- `daemon.ts`, `daemon-protocol.ts`, `daemon-client.ts`, `session-manager.ts` — this **is** the
  real `fluentd`: a working Unix-socket JSON-RPC server (`sessions.list/create/get/send/stop`)
  backed by real PTY sessions. Verified directly; this is sound and should keep being built on
  regardless of client technology.
- `index.tsx`, `theme.ts` — the Ink rendering of New Session, Session List, and Active Session,
  already wired to the daemon above. This is superseded by the Tauri frontend (§7.3): port the
  *RPC wiring* (which calls each screen makes, in what order) into the new frontend rather than
  the JSX itself.

**Protocol gap to close first:** the current protocol is request/response only —
`sessions.get` returns a point-in-time output string. Live-updating terminal panes need a
push/subscribe method (e.g. `sessions.subscribe` streaming output chunks) instead of polling.
Small additive change, not a rewrite.

### 7.5 Provider adapters

One per CLI. Each adapter knows, for its CLI only:
- How to detect installation and read subscription login state (checking the CLI's own state,
  never touching credentials directly).
- How to start a login flow (`claude login`, `codex login`, ...).
- How to inject an API key/base URL override via that CLI's own env vars (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` for Claude Code + OpenRouter; OpenAI equivalents for
  Codex).
- How to detect a usage-limit/rate-limit condition from the CLI's own signals.
- How to pass through "direction" (system prompt/task context) via that CLI's native convention —
  project `CLAUDE.md`/`AGENTS.md`, `--append-system-prompt`, or hooks config — never by
  intercepting or rewriting output.

**Claude Code specifically has a documented hooks system worth using directly** rather than
parsing terminal output:
- `StopFailure` carries an already-typed `error` field (`rate_limit`, `overloaded`,
  `authentication_failed`) — exactly the signal the credential broker needs (§9).
- `SessionStart`/`SessionEnd`/`PreCompact`/`PostCompact`/`Notification` give session-lifecycle and
  context-compaction visibility the same clean way.
- Every hook payload carries `session_id`, `cwd`, `permission_mode`, `transcript_path` — enough to
  correlate activity without parsing terminal output at all.
- A `PreToolUse` hook can `deny` a tool call, and this holds even under
  `--dangerously-skip-permissions` — a genuinely stronger boundary than Fluent could build itself,
  worth using for anything security-critical Fluent ever adds.

Codex's equivalent surface needs the same confirmation before assuming output-parsing is
required there — don't assume parity until checked.

Adding a new provider means writing one adapter to this interface; nothing else changes.

## 8. Security & permission model

Claude Code and Codex both already expose a two-dial mental model, just with different names:
**what can it touch** (Claude Code's permission modes; Codex's `sandbox_mode` —
read-only/workspace-write/danger-full-access) and **when must it ask** (Codex's
`approval_policy` — untrusted/on-request/never; Claude Code's permission prompts). Fluent Code
adopts this as shared vocabulary across providers even though each CLI exposes it differently —
it's what makes a single, coherent permission UI possible instead of two bespoke ones. Fluent
never loosens either dial itself; at most (per §7.5's `PreToolUse` note) it can tighten one via a
hook.

## 9. The credential broker

Per provider, per account, three independently connectable auth modes (screen 2 for connecting
them, screen 10 for ordering them):

1. **Subscription** — the CLI's own OAuth login. Flat included usage.
2. **Platform API credits** — pay-as-you-go, billed directly by the same provider (e.g. Anthropic
   Console credits) — the natural overflow tier for a subscription account.
3. **API key** — any key/endpoint, including a third-party router (OpenRouter preset).

All three talk **directly to the real provider.** Fluent Code has no backend, does no billing,
and never proxies model calls — it only decides, locally, which already-connected credential a
session should use right now (Principle 2, §2). This is a hard boundary.

**Precedence & fallback** (screen 10): the user sets an order per provider by dragging rows.
When the active credential hits a usage limit:
- `fluentd` reads the reset time the CLI itself reports (via hooks where available, §7.5).
- Per the user's configured preference (always ask / always switch / never switch — the
  three-way control on screen 10), Fluent either prompts — *"claude-code subscription resets in
  47m — switch to platform API credits and keep going?"* — or switches automatically, and either
  way starts a countdown to auto-revert.
- When the reset window passes, it switches back to the higher-precedence credential
  automatically.

This is pure orchestration of state that already exists — the CLI already holds the turn and
reports its own reset time. Fluent adds the notice/offer/revert loop, it doesn't reimplement
rate-limit tracking.

## 10. Hardware & token intelligence

`fluentd` samples system stats continuously — CPU, load, memory + pressure, disk + I/O, network,
GPU/VRAM + temp/power where available, per-process breakdown, via `systeminformation` (current,
maintained, zero-dependency, no reason to build this) — feeding screen 5's hardware grid.

**v1 scope is advisory, not enforcement:** recommend a safe max concurrent-agent count from
current headroom; warn before a new agent lane would likely overload the machine. A hard scheduler
that blocks/throttles agents is a plausible v2, never a v1 commitment — per-agent resource use is
too variable to gate reliably yet.

Token usage is tracked per session from each CLI's own reporting where available, rolled up per
project/day/month, split by main-agent vs. subagent (screen 11 makes this split explicit). For
context-bloat mitigation, Fluent triggers the underlying CLI's own tools (`/compact`,
`/doctor`-equivalents) at the right moment rather than reimplementing context management —
same "orchestrate, don't rebuild" principle as the credential broker.

All of this is local-first: screen 11 shows an explicit "local only · no remote write · no cloud
export" status. Nothing here implies a Fluent-run telemetry backend.

## 11. Coordination model (parallel orchestration)

Multiple agent lanes on one project (screen 6) are independent PTY sessions coordinated through
`fluentd`'s shared state:
- **Shared task board** — one list, each item assigned to a lane.
- **File claims** — a claim signals intent to edit a file; it is *not* an OS lock. Two lanes
  claiming overlapping files raises a visible conflict ("file overlap detected") rather than
  silently serializing or blocking.
- **Memory & decisions log** — a running feed of what each lane changed and why.
- **Handoffs** — one lane can request review or hand its output to another; always an explicit,
  visible action, never automatic.

Screen 7 (Design Workspace) is this same coordination model applied to a design-specific
pipeline: design/build/preview/QA agents claiming files and handing off through defined stages.

**Token-efficient by construction:** this coordination state sometimes gets injected into a
session's context (e.g. "what's the current task board / are there conflicts"). Research into
agent-communication efficiency (checking both the "AXI" — Agent eXperience Interface — concept and
its academic sibling ACI/Agent-Computer Interface from the SWE-agent paper) converged on the same
handful of concrete rules, applied here:
- Never inject full pretty-JSON snapshots. Default to minimal per-item fields (id/title/assignee/
  status); an agent can ask for more detail on one item rather than receiving everything.
- Send deltas since last check, not full state, when a session resumes or checks in.
- Serialize uniform list shapes (task board rows, file claims) as compact tabular text
  (TOON-style — CSV-like rows, no braces/quotes) rather than JSON — a measured 30–60% token
  reduction on exactly this shape of data.
- Expose one combined status query (tasks + claims + conflicts together) instead of several
  separate ones.
- Make empty states explicit ("0 open conflicts"), not an empty array to interpret.

This boundary is specifically `fluentd` → an agent's context. The daemon↔app RPC (§7.2) stays
ordinary JSON — that traffic never enters a model's context window, so none of this applies to it.

(Note on "AXI": verified directly rather than taken on faith — it's real, but narrower than a
communication protocol: a set of 10 design principles for CLI tool *output* aimed at agents
[axi.md](https://axi.md/), leaning on a serialization format called TOON. Its own benchmark claims
are self-reported, not independently validated the way MCP is — treated here as "a useful set of
techniques," not "a proven protocol to adopt wholesale.")

## 12. Theming system

Screen 12 is the product spec for this, not just a settings UI:
- **Appearance mode** (System/Light/Dark) is distinct from the selected **theme**. System is a
  resolver, not a theme itself — it maps to independently-chosen light and dark bundles.
- Theme choices are filtered by current mode — light and dark themes never appear in the same
  selection gallery.
- Each bundle is complete and independent: semantic colors (ground/surface/ink/muted/border/
  action/warning/success), terminal ANSI mapping, syntax colors, density, and font size all belong
  to the bundle, not to global settings.
- **Fluent Dark is default.** Every Fluent theme (Midnight, Ember, Nord Dark, High Contrast Dark,
  and their light counterparts) keeps the mark invariant and reserves Coral for actions/selection/
  warnings/anomalies per §4 — themeable, but the brand constraints aren't.

## 13. Non-goals

- Not re-implementing Claude Code's or Codex's agent loop, tool execution, or system prompt
  handling.
- Not a hosted or billed backend of any kind — every credential path talks to its real provider
  directly (§9).
- Not a hard resource scheduler in v1 — hardware intelligence is advisory (§10).
- Not a fork of T3 Code's monorepo, and not a fork or plugin of herdr (§3) — both are prior art,
  neither is a dependency.
- Not a bare-TTY/SSH-native app — that option closed once screen 8 required a real webview (§7.1).
  Own this tradeoff rather than re-litigating it later.

## 14. Open risks / questions

- **Codex's hook/telemetry parity with Claude Code is unconfirmed.** §7.5's rate-limit-detection
  design leans on Claude Code's `StopFailure` hook; if Codex has no equivalent, its adapter may
  need a documented, weaker fallback (output pattern-matching) — decide explicitly rather than
  silently assuming parity.
- **The daemon's RPC protocol needs a streaming/subscribe method before live terminal panes work**
  (§7.4) — small, but blocking for the first real Tauri screen.
- **Hardware-advisory thresholds are undefined** — "safe concurrent-agent count" needs an actual
  heuristic (e.g. free-RAM-per-agent-estimate), not just a stated intention. Needs a first pass and
  will need real-world tuning.
- **TOON/compact-serialization adoption (§11) is a v3-scoped concern** (coordination state doesn't
  exist until the orchestrator ships) — flagged here so it isn't forgotten by the time it's
  relevant.
- **What "OpenRouter" actually means is unresolved and matters.** The confirmed mechanism
  (§7.5/§9) is Claude Code pointed at OpenRouter's endpoint via `ANTHROPIC_BASE_URL` — this can
  only run Claude-family models, because Claude Code's own tool-calling/streaming format is
  Claude-specific regardless of which endpoint it's pointed at. But session-list mockup data
  elsewhere shows a model like `deepseek-r1` running under an OpenRouter credential — a non-Claude
  model, which the confirmed mechanism cannot produce. Either "OpenRouter" in the product is only
  ever an alternate billing/routing path for Claude Code or Codex's *own* model family (in which
  case the deepseek example was illustrative, not literal, and should be corrected in the design),
  or genuinely model-agnostic OpenRouter access is intended, which would require a third adapter
  for a harness that actually supports arbitrary providers (e.g. opencode, which supports 75+
  providers including OpenRouter — a scoped, one-more-adapter addition, not a re-opening of the
  "build our own harness" question already closed in §1/§13). Resolve this explicitly before
  building the OpenRouter path, not while building it.

## 15. Phasing

1. **v1** — `fluentd`: close the streaming-RPC gap, add the credential broker and hooks-based
   signal collection. `fluent` (Tauri): splash, provider onboarding, single active session via
   xterm.js, session list. One provider (Claude Code) fully working end to end, including
   credential fallback with the notify/revert loop.
2. **v2** — Second provider (Codex) + OpenRouter preset. Remote server screen (`fluentd` reachable
   from another machine, hardware + token dashboards live). Preview & Visual Check screen (the
   webview requirement that shaped §7.1).
3. **v3** — Parallel orchestrator and design workspace: task board, file claims, handoffs,
   hardware-aware agent-count advisory, full theme system.
