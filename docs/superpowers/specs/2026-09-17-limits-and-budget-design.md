# Limits, budgets and attention — design

Status: decided 2026-09-17 after four research passes (market, token economics, funding, UX audit;
summaries in `docs/research/2026-09-17-*.md`). This spec is the product decision that came out of
them and the scope of the release that implements it.

## 1. The decision

Fluent Code's lane grid, worktree isolation and parallel sessions are now table stakes: Claude
Code's desktop app and the Codex app ship them free, herdr/Emdash/cmux give them away, and the two
startups that charged for that primitive (Bloop's vibe-kanban, Terragon) shut down in H1 2026.

What developers demonstrably suffer from, and hand-roll today, is the money and the limits:

- Max 5x windows exhausted in ~90 minutes; a $6,000 overnight bill; Microsoft citing
  ~$2,000/engineer/month. An open Claude Code issue (#43260) and a forked community script
  (`claude-swap`) ask for exactly the subscription → credits fallback Fluent's broker already does.
- Unattended agents are a fat-tail risk (a documented $47,000 / 11-day runaway). Nothing local
  today stops a lane at a dollar figure.
- Prompt-cache continuity is the single biggest saving lever (cache reads ~10% of price; real
  Claude Code sessions are ~91% cache-served). A mid-task credential switch drops the 1-hour TTL to
  5 minutes and re-prices the lane; the user never sees that cost.
- "Which one needs me" is the pain Cursor rebuilt its agent UI around.

No funded competitor owns a cross-vendor credential and spend layer for agent CLIs. That is the
wedge. **This release makes Fluent the place a developer sees, and caps, what their agents cost and
how much of their limits they have left** — from data fluentd already collects — and fixes the
first-run and correctness defects the UX audit found.

Explicitly out of scope: any backend, billing, proxying, a mobile/remote tier, loop *detection*
heuristics (false positives would be worse than the cap), and reimplementing anything inside an
agent turn (CLAUDE.md's one rule).

## 2. What ships

### 2.1 Limits strip (workspace header)

Above the lane grid, one line per connected credential that has reported a window: provider,
account label, `5h 41% · resets 2h12m`, `7d 12%`. Data: `credentials.list` accounts'
`quotaUsedPercent/quotaResetsAt` and `usage.snapshot` sessions' `quota` (Claude via hooks, Codex
via app-server). Colour: neutral under 70%, warn (coral) at ≥70% and a countdown. A credential with
no report shows nothing (no dashes). Clicking opens the credentials page.

### 2.2 Lane cost on every tile

The lane header already shows tokens. It now shows `$0.42 · ctx 31%` when the provider reports
cost/context (Claude hooks), or an estimate `≈$0.42` from tokens × the spend tracker's price table
for the lane's model when it does not. Cache hit ratio in the tile tooltip. Lanes over 80% of their
budget get a coral pill `budget 82%`.

### 2.3 Per-lane budget with auto-stop

- `sessions.create` accepts `budgetUsd?: number`. The launch form has one field, "stop a lane at
  $ ___" (blank = no cap), remembered in prefs and applied to every lane the form starts.
  Subagents a lead starts inherit the lead's budget.
- fluentd checks the lane's cost on every usage update (`hooks.report`, app-server token updates).
  When cost ≥ budget: stop the lane (`SIGTERM`, the existing stop path), record
  `stoppedBy: 'budget'` on the summary, and push `sessions.attention` with a new reason
  `'budget'`. The lane can be resumed with a higher cap from its menu (existing resume path plus a
  new budget).
- Cost source: reported `costUsd` when present; otherwise estimated from tokens with the spend
  tracker's prices (marked `estimated: true`). A lane with neither shows "cost unknown" and is not
  stoppable by budget — say so on the tile rather than pretend.

### 2.4 Attention inbox

A bell in the top bar with a count. Opens a list of lanes that need the user, newest first:
`needs you`, `failed`, `over budget`, `finished`, plus credential notices (a limit hit, a
fallback offered/taken). Each row: provider, lane name, reason, age; click focuses the lane (or
opens credentials for a notice) and clears it. The same list backs the existing rail counts.
Credential notices are kept in the store until dismissed; they are the one thing the user must
never miss.

### 2.5 Spend page: windows and lanes

- Top of the page: the same per-credential window gauges as 2.1, larger, with reset times.
- New "by lane" table: session name, provider/model, cost (reported or estimated), tokens,
  cache hit %, status, started; sorted by cost. Joins `sessions.list` and `usage.snapshot` in the
  frontend; no new RPC.
- "Fallbacks": count of `credential.switched` events in the range with when and why, so the
  broker's value is visible ("3 fallbacks kept lanes running this week"). fluentd appends each
  switch to `credential-events.jsonl` in the state dir; `spend.summary` returns them for the range.

### 2.6 Fallback and cache honesty

When the broker asks "switch to the next credential?", the notice includes the cache cost:
"switching drops this lane's 1-hour prompt cache; its next turn re-reads context at full price."
No new logic, just the sentence in `FallbackGuidance.detail`.

### 2.7 First-run and correctness (from the audit)

1. Terminal panes ignore light appearance mode (real render bug in `app/src/terminal.ts`).
2. Top bar and rail read `prefs.workspacePath` raw and contradict the workspace strip; use
   `currentProject()` like `workspace.ts` does.
3. Onboarding is orphaned once a CLI is installed; add "connect another provider" on Credentials.
4. Splash auto-advances for a returning user (workspace saved) instead of waiting for Enter.
5. Usage page provider table gets column headers.
6. Empty state offers recent workspaces (last five folders, in prefs) above the directory field,
   and one line saying what Fluent adds over terminals: "runs the real CLIs; falls back when a
   credential hits its limit; stops a lane at your budget; shows what each lane costs."
7. Grid tiles keep a minimum height (200px) and the grid scrolls vertically instead of shrinking
   type past readability at 9–12 lanes.
8. Rail nav shows a bottom fade when it overflows.

### 2.8 Positioning

README's opening and AGENTS.md's designed-screens list describe what ships: lead with fallback,
budgets and limits; describe Preview and Design as the connector pages they are today, not the
full screens in the Pen file.

## 3. Data and boundaries

- All figures come from the providers' own reporting (hooks, app-server) or from transcripts the
  user already has; nothing is sent anywhere (spec §10 local-first).
- Budget enforcement is a stop, not a throttle; it uses the existing stop path and the existing
  attention/notification path. Advisory-only stays for hardware (spec §10); money is the one
  thing the user explicitly asked to be enforced by setting a cap.
- The daemon owns cost estimation (one price table, `spend-tracker.ts`), the frontend only
  formats. New protocol fields are optional so older clients keep working.

## 4. Verification

- Unit tests: budget check (reported vs estimated vs unknown; inherit for subagents; stop once),
  credential event log, attention reason `budget`, window formatting.
- `pnpm check`, `pnpm check:frontend`, `pnpm test`, `pnpm test:frontend`.
- Fixture screenshots (`scripts/qa/shoot.mjs`) for: limits strip, tile cost/budget pill, inbox
  open, spend page windows + by-lane, empty state with recent workspaces, light mode with a lane.
- Live run (`scripts/qa/live.mts`) with stand-in CLIs: a lane stops at its budget and the inbox
  shows it.
- Packaged dmg installed and the daemon answers `usage.snapshot` with quota after one real Claude
  turn.
