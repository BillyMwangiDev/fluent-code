# Limits, budgets and attention — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make what agents cost, and how much of each credential's limit is left, visible on every
screen; stop a lane at a dollar budget; collect everything that needs the user into one inbox; and
fix the first-run and rendering defects the 2026-09-17 UX audit found.

**Architecture:** fluentd already receives per-session cost/context/quota from Claude Code's hooks
and Codex's app-server (`src/usage-monitor.ts`), and the broker already emits `credential.switched`
/ `credential.notice`. The daemon gains one small module (`src/budget.ts`) that turns a usage
update into a stop, one append-only log of credential switches, and optional protocol fields. The
frontend gains pure helpers (`app/src/limits.ts`), a store-backed inbox, and renders the new fields
in the workspace header, lane tiles, launch form and spend page. No new background services, no new
sockets, nothing leaves the machine.

**Tech stack:** TypeScript (Node 22 daemon, vanilla-TS Tauri frontend), `node --test`, esbuild,
Playwright fixture screenshots (`scripts/qa/shoot.mjs`), live run (`scripts/qa/live.mts`).

Spec: `docs/superpowers/specs/2026-09-17-limits-and-budget-design.md`. Read it first.

---

## File ownership (parallel-safe)

| Task | Owns (may edit) | Must not edit |
|---|---|---|
| T1 daemon | `src/daemon-protocol.ts`, `src/budget.ts` (+test), `src/credential-events.ts` (+test), `src/daemon.ts`, `src/session-manager.ts`, `src/lead-lanes.ts`, `src/credential-broker.ts`, `src/usage-monitor.ts`, `src/spend-tracker.ts`, `src/codex-app-server.ts`, `src/native-sessions.ts` | anything under `app/` |
| T2 frontend fixes | `app/src/terminal.ts`, `app/src/pages/splash.ts`, `app/src/pages/credentials.ts`, `app/src/pages/usage.ts`, `app/src/shell.ts` (only `renderTopbar` project label and the rail switcher label), `app/styles.css` (append a clearly-commented block at the end only) | `app/src/workspace.ts`, `app/src/launch*.ts`, `app/src/api.ts`, `app/src/store.ts`, `app/src/pages/spend.ts` |
| T3 spend page | `app/src/limits.ts` (+test), `app/src/pages/spend.ts`, `app/src/api.ts` (only: add `CredentialEvent`, `credentialEvents?` on `SpendSummary`, `costSource?` on usage sessions), `scripts/ui-qa-harness.html` (only: spend.summary and usage.snapshot fixture data), `app/styles.css` (append a clearly-commented block at the end only) | `app/src/workspace.ts`, `app/src/shell.ts`, `app/src/store.ts` |
| T4 workspace, launch, inbox | `app/src/api.ts`, `app/src/store.ts`, `app/src/inbox.ts`, `app/src/workspace.ts`, `app/src/launch.ts`, `app/src/launch-plan.ts` (+test), `app/src/prefs.ts`, `app/src/shell.ts` (add the bell to `renderTopbar`), `app/src/main.ts`, `scripts/ui-qa-harness.html`, `scripts/qa/shoot.mjs`, `app/styles.css` | `src/` |
| T5 docs | `README.md`, `AGENTS.md` | code |

Order: T1, T2, T3 in parallel → T4 (needs T1's protocol and T2's shell edits landed) with T5 in
parallel → T6 verification and packaging.

Every task: run `pnpm check && pnpm check:frontend && pnpm test && pnpm test:frontend` before its
commit; commit only its own files; conventional commit message; no attribution lines.

---

## T1 — daemon: budget stop, credential event log, cost source, cache-honest guidance

**Protocol changes (`src/daemon-protocol.ts`)** — all optional so old clients keep working:

```ts
// SessionSummary
/** Dollar cap the user set for this lane; fluentd stops the lane when its cost reaches it. */
budgetUsd?: number;
/** Set when fluentd stopped the lane itself rather than the user. */
stoppedBy?: 'budget';

// sessions.create params: add `budgetUsd?: number`
// sessions.resume params: add `budgetUsd?: number` (a lane stopped by budget resumes with a new cap)

// UsageSnapshot sessions[]: add
/** Where costUsd came from: the provider's own figure, fluentd's price table, or nowhere. */
costSource?: 'providerReported' | 'modelPriced' | 'unpriced';

// RpcEvent sessions.attention reason: 'finished' | 'failed' | 'needs-input' | 'budget'

export type CredentialEvent = {at: string; provider: ProviderId; fromAccountId?: string; toAccountId: string; reason: 'fallback' | 'revert' | 'manual'; resetAt?: string};
// SpendSummary (src/spend-tracker.ts): add `credentialEvents?: CredentialEvent[]` (filled by daemon.ts for the range)
```

**`src/budget.ts`** (pure, tested):

```ts
import type {CostSource} from './spend-tracker.js';
export type BudgetVerdict = {over: boolean; percent?: number; costUsd?: number; budgetUsd?: number; enforceable: boolean};
/** enforceable=false when the lane has no budget or no cost figure (unpriced) — never stop on a guess of zero. */
export function budgetVerdict(usage: {costUsd?: number; costSource?: CostSource} | undefined, budgetUsd?: number): BudgetVerdict;
/** A subagent inherits its lead's cap; an explicit cap on the subagent wins. */
export function inheritedBudget(requested: number | undefined, parent: {budgetUsd?: number} | undefined): number | undefined;
/** Valid cap: finite, > 0, ≤ 10_000; anything else throws a plain Error naming the rule. */
export function validBudgetUsd(value: unknown): number | undefined;
```

Tests (`src/budget.test.ts`): over at exactly the cap; not enforceable when unpriced or no budget;
percent rounds to a whole number; inheritance (parent 5, requested undefined → 5; requested 2 → 2;
no parent → undefined); `validBudgetUsd` rejects 0, negative, NaN, strings, > 10000.

**Cost estimation** (`src/usage-monitor.ts` + `src/spend-tracker.ts`): export from spend-tracker a
`rateForModel(model: string): ModelRate | undefined` using the already-loaded LiteLLM table and
overrides. In `UsageMonitor`, after any record that has input/output tokens but no reported cost,
set `costUsd = tokens × rate` and `costSource = 'modelPriced'` when a rate exists, else
`costSource = 'unpriced'`. Reported cost sets `costSource = 'providerReported'`. Codex: check
`src/codex-app-server.ts` for token-count notifications; if the app-server reports token usage,
record it as inputTokens/outputTokens (so Codex lanes get a modelPriced cost); if it does not,
leave Codex as unpriced and say so in a code comment — do not invent numbers.

**Enforcement (`src/daemon.ts`, `src/session-manager.ts`)**: `create()` accepts and stores
`budgetUsd` (validated with `validBudgetUsd`). A lead's `lane start` (`src/daemon.ts` case
`'start'` in the agent.lane handler, ~line 516) passes `inheritedBudget(requested, parentSummary)`.
After every usage record (`hooks.report` → `recordClaude`; Codex token updates), call
`enforceBudget(sessionId)`: if the lane is live, `budgetVerdict(...).over`, and `stoppedBy` is not
already set → `manager.stop(id)`, set `summary.stoppedBy = 'budget'`, broadcast
`sessions.attention` with `reason: 'budget'` and `detail: 'stopped at $X.XX of $Y.YY'`. Stop once:
a second usage update for the same lane must not emit again. `sessions.resume` with `budgetUsd`
clears `stoppedBy` and sets the new cap.

**Credential event log (`src/credential-events.ts`, tested)**: `appendCredentialEvent(stateDir,
event)` using `appendPrivateLine` to `credential-events.jsonl`; `listCredentialEvents(stateDir,
sinceMs)`. Wire the broker's `'switched'` emit in `daemon.ts` to append one event (the broker
already passes provider/accountId/reason; add the previous account id and resetAt where known).
`spend.summary` returns `{...summary, credentialEvents}` for the range.

**Guidance sentence (`src/credential-broker.ts` `guidance()`)**: when the recommendation is
`switch` and the limited account is a subscription, append to `detail`: "Switching drops this
lane's 1-hour prompt cache; its next turn re-reads context at full price." Adjust the existing
broker test that asserts `detail` if one does.

Commit: `feat(daemon): per-lane budget stop, credential event log, cost source`.

---

## T2 — frontend correctness and first-run fixes

1. **Light-mode terminal** (`app/src/terminal.ts`, `attachLaneTerminal`): reproduce with
   `THEME=light ONLY=light node scripts/qa/shoot.mjs <out>` and a pixel check of a lane pane (the
   fixture supports `?theme=light`; read the top of `scripts/ui-qa-harness.html` to confirm the
   query name). Likely fixes, in order: assign `terminal.options.theme = terminalTheme()` after
   `terminal.open(container)`; re-apply on the app's theme-change event (grep `data-theme` and
   `themechange` in `app/src` for the existing hook). Verify with a fresh screenshot: lane background
   must be light. Add the light-with-lane scenario to `scripts/qa/shoot.mjs` if it is not there
   (this is the one file T2 may add a scenario to; coordinate: append only).
2. **Top bar / rail label** (`app/src/shell.ts`): replace the raw `prefs.workspacePath` reads in
   `renderTopbar()` and the rail switcher's name/path with
   `currentProject(prefs.workspacePath, store.sessions)` from `app/src/project-scope.ts` (same call
   `workspace.ts:57` makes). Empty → keep the existing "no workspace selected"/"choose a workspace".
3. **Onboarding reachable** (`app/src/pages/credentials.ts`): a `button('connect another provider…',
   () => navigate({name: 'onboarding'}), {class: 'btn ghost'})` in the page header actions.
4. **Splash auto-advance** (`app/src/pages/splash.ts`): when `prefs.workspacePath` is set and
   `canStart`, call `advance()` 400 ms after the providers render (keep Enter/click working before
   that). First run keeps the prompt.
5. **Usage table headers** (`app/src/pages/usage.ts`): a header row `model · context · tokens ·
   cache · cost · windows · updated` above the provider usage rows, `class: 'table-head muted'`.
6. **Grid minimum tile height** (`app/styles.css`): `.lane-grid .lane { min-height: 200px; }` and
   the grid container `overflow-y: auto` so 9–12 lanes scroll instead of shrinking; confirm with
   `ONLY=workspace-12 node scripts/qa/shoot.mjs <out>` that titles no longer truncate to 2 letters.
7. **Rail overflow fade** (`app/styles.css`): `.rail-scroll` gets a bottom mask
   (`mask-image: linear-gradient(to bottom, #000 calc(100% - 24px), transparent)`) only when it
   overflows — simplest: always apply; the fade is invisible when nothing is under it.

Commit: `fix(desktop): light-mode terminals, consistent workspace label, reachable onboarding, splash auto-advance, readable dense grid`.

---

## T3 — limits helpers and the spend page

**`app/src/limits.ts`** (pure, tested with `node --test` under `app/src/*.test.ts`, run by
`pnpm test:frontend`):

```ts
export type Window = {usedPercent?: number; windowMinutes?: number; resetsAt?: string};
/** "5h 41% · resets 2h12m" / "7d 12%"; undefined when nothing is reported. */
export function windowLabel(window: Window | undefined, now?: Date): string | undefined;
/** 'ok' | 'warn' (≥70%) | 'critical' (≥90%) */
export function windowLevel(window: Window | undefined): 'ok' | 'warn' | 'critical' | undefined;
/** "$0.42" for reported, "≈$0.42" for modelPriced, "cost unknown" for unpriced, undefined when no figure */
export function laneCostText(usage: {costUsd?: number; costSource?: string} | undefined): string | undefined;
/** whole-number percent of budget used, undefined when not applicable */
export function budgetPercent(costUsd: number | undefined, budgetUsd: number | undefined): number | undefined;
/** Merge per-session quota reports into one window pair per provider (latest observedAt wins). */
export function windowsByProvider(sessions: Array<{provider: string; quota?: {primary?: Window; secondary?: Window; observedAt: string}}>): Map<string, {primary?: Window; secondary?: Window; observedAt: string}>;
```

**`app/src/pages/spend.ts`**:
- Top: "limits" card — one row per provider from `windowsByProvider(store.usage.values())` merged
  with `api.listCredentials()` account windows: provider label, account label, primary and
  secondary `windowLabel`, colour class from `windowLevel`. Nothing reported → one muted line
  "no limit windows reported yet — they appear after a lane's first turn".
- "by lane" table: join `store.sessions` (including archived? no: last 30 days, not archived) with
  `store.usage`: name (`sessionName`), provider · model, cost (`laneCostText`), tokens, cache hit %,
  status, started (relative). Sort by cost desc. Empty → "no lane usage yet".
- "fallbacks" list from `summary.credentialEvents ?? []`: "claude · work subscription → work
  platform credits · fallback · 2h ago (resets 14:10)"; header count "3 fallbacks kept lanes
  running in the last 30d"; empty → "no credential switches in this range".
- Fixture: add `credentialEvents`, `costSource`, and a `quota` on two sessions to
  `scripts/ui-qa-harness.html` so `ONLY=spend node scripts/qa/shoot.mjs <out>` shows all three
  blocks populated; screenshot and read it.

Commit: `feat(desktop): limit windows, per-lane cost and fallback history on the spend page`.

---

## T4 — workspace strip, tile cost, budget field, inbox

Requires T1, T2, T3 committed. Read `app/src/limits.ts` and the protocol first.

1. **`app/src/api.ts`**: mirror T1's fields (`budgetUsd`, `stoppedBy`, `costSource` if T3 missed
   it, attention reason `'budget'`); `createSession` and `resumeSession` accept `budgetUsd`.
2. **`app/src/store.ts`**: `chains: CredentialChainState[]` refreshed with the usage poll (30 s
   cadence is fine); `notices: Notice[]` where `Notice = {id: string; at: string; provider:
   ProviderId; message: string; resetAt?: string; kind: 'notice' | 'switched'}` appended from
   `credential.notice` / `credential.switched` events (grep `onCredentialNotice` in api.ts; add a
   subscriber if only main.ts has one) and removed by `dismissNotice(id)`; `inbox(): InboxItem[]`
   = attention entries (`{kind:'lane', sessionId, reason, at, summary, detail}`) + notices, newest
   first. Attention reason `'budget'` gets a title "over budget" in `main.ts`'s notification map.
3. **`app/src/inbox.ts`**: `renderInboxButton(): HTMLElement` — a `btn ghost icon-button` with a
   bell icon (add `bell` to the icon set in `ui.ts` if missing) and a count badge; click opens a
   popover (`openMenu` or a small `h('div', {class: 'inbox-pop'})` anchored under the button)
   listing `store.inbox()`: rows `[provider · lane name] [reason pill] [age]`, click → for lanes
   `navigate({name:'orchestration'})` + focus that lane (grep how the rail focuses a lane in
   `shell.ts`), for notices `navigate({name:'credentials'})`; both clear the entry. Empty: "nothing
   needs you". Subscribes to the store to re-render the count.
4. **`app/src/shell.ts` `renderTopbar`**: add `renderInboxButton()` before the palette button.
5. **`app/src/workspace.ts`**:
   - Limits strip under the workspace header (`class: 'limits-strip'`): from
     `windowsByProvider([...store.usage.values()])` and `store.chains` (account label = active
     account's label); one chip per provider: `claude · work subscription · 5h 41% · resets 2h12m ·
     7d 12%`, class from `windowLevel`; click → credentials. Hidden entirely when nothing is
     reported. Patch in place from the store subscription like the rest of the header.
   - Tile header: replace `usageText(usage)` with `[tokens, laneCostText(usage), ctx %]` joined by
     ` · `; tooltip with cache hit %; when `summary.budgetUsd` and `budgetPercent(...) >= 80` add a
     coral pill `budget 82%`; when `summary.stoppedBy === 'budget'` show pill `stopped at budget`
     and the tile menu offers "resume with a higher budget…" (prompt via the existing in-app
     `askConfirm`/prompt helper in `ui.ts`; never `window.prompt` — wry has no native dialogs).
   - Empty state: above the directory field, "recent" chips for `prefs.recentWorkspaces` (last five,
     newest first; `prefs.ts` gains `recentWorkspaces: string[]` maintained wherever
     `prefs.workspacePath` is set — add a `rememberWorkspace(path)` helper in prefs.ts and call it
     from the existing setters' call sites in workspace.ts/launch.ts/shell.ts; shell.ts is T2's file
     but the rail switcher's setter is a one-line call — allowed here since T2 has landed). Below the
     title, one line: "runs the real CLIs · falls back when a credential hits its limit · stops a
     lane at your budget · shows what every lane costs".
6. **`app/src/launch.ts` / `launch-plan.ts` / `prefs.ts`**: in "more options", a numeric field
   `stop a lane at $ [   ]` (`inputmode="decimal"`, blank = no cap), stored in
   `prefs.launchOptions.budgetUsd`, carried in `LaunchRequest.budgetUsd`, passed to every
   `api.createSession` the plan makes (main agent and lanes). Update `launch-plan.test.ts` for the
   new field.
7. **Fixture + screenshots**: give two fixture sessions `budgetUsd`, one `stoppedBy: 'budget'`, usage
   with `costSource`, and a quota on the claude sessions; add shoot scenarios `limits` (workspace-6
   with the strip), `inbox` (open the popover), `tile-budget` (focus the stopped lane). Read every
   new screenshot.

Commit: `feat(desktop): limits strip, lane cost and budget, attention inbox, recent workspaces`.

---

## T5 — positioning

- `README.md`: rewrite the opening paragraph and the feature list so the first three bullets are
  credential fallback on limits, per-lane budgets with auto-stop, and limit/spend visibility;
  parallel lanes and coordination follow. Add a "what it costs to run" section: orchestration
  raises raw token spend (subagents ~4x; cite Anthropic's post), so Fluent reports cost per lane and
  caps it. Keep the existing packaging/credential sections.
- `AGENTS.md` designed-screens 7 and 8: describe Preview and Design as they ship (a guarded
  preview window launcher; design-tool connector status and install) and note the Pen artboards as
  the target. Add a screen entry for the limits strip / inbox.

Commit: `docs: position Fluent around limits, budgets and fallback`.

---

## T6 — verification and packaging (main session)

1. `pnpm check && pnpm check:frontend && pnpm test && pnpm test:frontend && pnpm build && pnpm build:frontend`.
2. `node scripts/qa/shoot.mjs <out>` for all scenarios; read `empty`, `workspace-6`, `limits`,
   `inbox`, `tile-budget`, `spend`, `light`, `workspace-12`, `credentials`, `usage`.
3. Live: `node --import tsx scripts/qa/live.mts` (stand-in CLIs) still passes; add a budget case if
   the harness makes it cheap (stand-in CLI reports a hook payload with cost ≥ cap → lane stops,
   inbox shows it).
4. `pnpm package:mac`, mount, `ditto` into /Applications, launch, and confirm over the socket:
   `sessions.create` with `budgetUsd` echoes it; `spend.summary` returns `credentialEvents`.
5. Push, run the desktop-package workflow for the Windows exe, download it.
