# Fluent Code

## Project

Fluent Code is an open-source, terminal-first coding-agent client. It lets a developer operate Claude Code, Codex, and OpenRouter-backed models from one TUI. It is a fork of T3 Code's orchestration engine with a new interface.

Primary product goals:

- Support existing CLI subscription login, platform API credits, and API-key onboarding as equally first-class paths — all talking directly to the real provider, never through a Fluent-run backend.
- Let a user set precedence across those credential modes per provider, and fall back automatically (with notice and an auto-revert timer) when one hits a usage limit.
- Let developers run multiple terminals, sessions, and models concurrently on the same project.
- Coordinate same-project agents so they can share context, hand off work, reserve files, surface conflicts, and avoid overlapping edits.
- Track hardware (CPU/RAM/disk/network/GPU) and token usage to advise on safe concurrent-agent counts and healthy context size — advisory, not enforcement.
- Support remote connections to a server running on another machine.

## Product vocabulary

- **Provider**: Claude Code, Codex, or OpenRouter. Open question (see the design spec's open
  risks): whether OpenRouter is only an alternate billing/routing path for Claude Code or Codex's
  own model family, or a genuinely model-agnostic third provider — resolve before building it.
- **Account**: the subscription, platform-credits, or API-key identity used by a provider.
- **Credential chain**: a provider's ordered precedence across subscription / platform API credits / API key, with automatic fallback and revert on a usage-limit hit.
- **Session / thread**: an in-progress agent conversation and its terminal context.
- **Agent lane**: one concurrent terminal session in the orchestration view.
- **File claim**: a non-destructive reservation that signals an agent intends to edit a file.
- **Coordination**: shared task board, project memory, decisions, handoffs, reviews, and conflict resolution across agent lanes.

## Current design direction

The product must feel like a developer terminal tool, not a consumer chat app:

- Default to a dark, monospace-forward interface with `#1f1e1d` as the primary ground.
- Use IBM Plex Mono for terminal chrome, code, metadata, versions, and dense data UI.
- Use Archivo for headlines and the wordmark only.
- Keep language plain, practical, and encouraging. Avoid hype such as “revolutionary,” “seamless,” or “10x.”
- Avoid chat bubbles and oversized illustrations.
- Use dense information design: compact cards, terminal panes, tables, sparklines, line/area charts, and clear state labels.

### Brand rules

- Wordmark: lowercase `fluent` + `code`, Archivo Bold, tight tracking.
- Mark: a 26×26 box containing four radius-6 circles at `(8,8)`, `(18,8)`, `(8,18)`, `(18,18)`.
  - Top-left, top-right, bottom-left: Canvas `#f5f4ee`.
  - Bottom-right: Coral `#d97757` — always bottom-right; never recolor or move it.
- Palette:
  - Canvas `#f5f4ee`
  - Surface `#faf9f5`
  - Ink `#1f1e1d`
  - Ink 2 `#4a4843`
  - Ink 3 `#7a7869`
  - Border `#e3e1d9`
  - Coral `#d97757`
  - Coral Hover `#c15f3c`
  - Coral Tint `#f6e6de`
- Coral is an accent/action and alert color only. Do not use it for large fields or ordinary data series.
- Radii: cards 12px, buttons 8px, chips 999px.

## Designed screens

The current Pen design covers:

1. First-run splash: mark, wordmark, version, and active providers.
2. Provider onboarding: Claude Code/Codex subscription CLI login plus equal-weight API-key flows and an OpenRouter preset.
3. Active session: streaming output, inline bash and file-edit tool calls, and risky-action approval.
4. Session list: multiple threads with provider, account, status, tokens, and timestamps.
5. Remote server: connected hosts, embedded terminal, model usage, hardware, and software observability.
6. Parallel orchestration: five simultaneous terminal lanes, shared task board, file claims, conflict resolution, project memory, agent handoffs, per-lane burn traces, and shared main-plus-subagent budget context.
7. Design workspace: repo-native design tasks, component/token specs, live preview, source mappings, file claims, and design-to-build handoff.
8. Preview & visual check: docked localhost preview, DOM/source mapping, console and network state, visual comparison, mismatch-to-agent actions, and approval/task actions.
9. New session: provider/account picker, explicit credential default, working directory, optional starting task, and keyboard-first launch.
10. Claude Code credentials: ordered credential chain and fallback behavior.
11. Usage observatory: local-first token, cache, spend, burn-rate, quota, model/agent, and active-session analysis that explicitly includes subagents.
12. Themes & appearance: independent System, Light, and Dark modes; mode-filtered theme bundles; terminal ANSI/syntax/density settings.

## Remote observability UI

Favor graph-first display over progress bars:

- Use sparklines, line charts, compact area charts, token-flow streams, and multi-series usage traces.
- Show model/provider usage, token rate, prompt/completion/cache tokens, budget, and context window.
- Show CPU/load, memory pressure, disk I/O, network throughput, GPU/VRAM, temperature/power, PSI, and top-process trends.
- Show software health: OS/kernel, runtime and adapter versions, agent service state, ports, Git state, containers, and last sync/deploy.
- Capacity bars are reserved for context window, disk capacity, and monthly budget.
- Coral indicates warnings, threshold lines, anomalies, or important actions only.

## Design artifact

The repository copy at `design/pen/fluent-code.pen` is the implementation source of truth. Its companion `design/README.md` maps all artboards to preview exports.

A local Pen working copy may exist, but do not rely on it for implementation. Update the repository `.pen` source and exports whenever a design changes. Preserve existing artboards when extending the canvas unless the task explicitly calls for an in-place update.

## Theme contract

- Appearance mode (`System`, `Light`, `Dark`) is distinct from the selected theme.
- Filter theme choices by the current mode. Never place light and dark theme options in the same normal selection gallery.
- System mode maps to independently selected light and dark bundles; each bundle owns semantic tokens, terminal ANSI colors, syntax tokens, font size, and density.
- Fluent Dark is default. All Fluent themes keep the mark invariant and Coral constraints above.

## Working agreements

- Prefer incremental, scoped changes; do not replace working flows or unrelated artboards.
- Before implementing UI, map a feature to one of the product concepts and designed screens above.
- Keep provider and account information explicit wherever sessions are shown.
- Treat agent collaboration as inspectable and user-controlled: show claims, conflicts, handoffs, and decisions rather than hiding coordination.
- Require explicit approval before risky terminal or file-system actions in the product UI.
