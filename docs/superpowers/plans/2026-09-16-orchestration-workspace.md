# Orchestration workspace

Date: 2026-09-16. Goal set by the user: the app is built but not usable, because it is not
efficient. Make it feel like a bare terminal that can orchestrate: fast, uncramped, effortless
from "write a prompt, allocate 5 Claude + 5 Codex + 5 GLM" to watching them work.

## What was wrong (measured on the QA fixture, 1440×900)

- `app/src/main.ts` (3,860 lines) rebuilt the entire page on every action. On the orchestration
  route that disposed and re-attached every lane terminal — ten snapshot replays per click.
- Orchestration was a document, not a workspace: launcher card, composer, 300px terminal tiles,
  metric cards, a command centre, an explorer, and nine more cards. Terminals sat mid-scroll.
- Terminals were boxed: card radius, padding, shadow, 11px type, inside another card.
- The launcher counted Claude and Codex only. GLM, Qwen, NVIDIA (OpenCode) and Gemini needed the
  one-at-a-time New Session page.
- Every coordination list carried an always-visible form. Opening a lane navigated away from the
  grid and back again remounted everything.

## Design

- **Workspace, not page.** `orchestrate` fills the viewport: a 40px strip (project, live counts,
  headroom, actions), a lane grid, a broadcast composer, and a collapsible coordination sidebar.
  The grid never scrolls the page; the sidebar scrolls itself.
- **Lanes as panes.** Tiles have a 30px header (status, provider · model, task, tokens, checks)
  and a terminal that takes the rest. Grid mode shows all lanes; focus mode (Enter, double-click,
  ⌘1–9) gives one lane the plane and lists the rest as a compact strip. Terminals stay mounted
  across mode switches, sidebar changes, and every coordination action.
- **One launch sheet** (`+ lanes`, ⌘N) with a prompt, per-provider steppers for every installed
  and connected provider, isolation, model, permission mode, and a lead option. Lanes appear in
  the grid as each starts. With no lanes the same form is the empty state.
- **Composer.** One input at the bottom sends to the focused lane, checked lanes, or all lanes.
- **Sidebar.** Tasks, claims and overlaps, handoffs, messages, and memory as compact lists with
  per-item actions and a single inline add per section. Master brief, planner, skill, and evals
  live behind a `board` tab.
- **Command palette** (⌘K) for navigation and every workspace action.
- **Incremental updates.** A session store polls `sessions.list` while the workspace is mounted
  and folds in `session-status`, `session-attention`, and coordination events; tiles and the
  sidebar patch in place.

## Code

`main.ts` becomes a router entry. Extracted: `ui.ts`, `prefs.ts`, `router.ts`, `terminal.ts`,
`charts.ts`, `shell.ts` (rail, topbar, palette), `launch-plan.ts` (pure, tested), `lane-layout.ts`
(pure, tested), `launch.ts`, `workspace.ts`, `coordination-panel.ts`, `session-view.ts`, and
`pages/*.ts` for the unchanged control-plane routes.

## Verification

- `pnpm check:frontend`, `pnpm test:frontend`, `pnpm build:frontend`, `pnpm test`.
- Screenshots of every route through `scripts/ui-qa-harness.html` (`node scripts/qa/shoot.mjs`)
  at 1440×900 and 1180×760, including 0, 1, 3, 6, and 12 lanes, focus mode, sidebar open/closed,
  the launch sheet, and the palette.
- The packaged frontend against a real fluentd with stand-in provider CLIs.
