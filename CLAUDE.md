# CLAUDE.md — Fluent Code

- Product vision, brand, vocabulary, and designed screens: [`AGENTS.md`](./AGENTS.md).
- Full end-to-end architecture, reasoning, and open risks: [`docs/superpowers/specs/2026-09-13-fluent-code-design.md`](./docs/superpowers/specs/2026-09-13-fluent-code-design.md) — **read that before making
  any non-trivial change.** This file only holds what you need at a glance; it does not restate
  the spec.

## The one rule

Claude Code and Codex already have a proper harness. Fluent Code runs them as real, unmodified
processes and orchestrates *around* them — credentials, concurrency, coordination, visibility.
It never re-implements what happens inside an agent turn. If a feature idea requires that, it's
out of scope; see the spec's Non-goals section.

## Quick facts (details in the spec)

- **Not a fork** of T3 Code or a fork/plugin of herdr — both are prior art, neither is a
  dependency (spec §3).
- **`fluent`** is a Tauri desktop app (not Ink/pure-terminal) — required because one screen
  (Preview & Visual Check) embeds a real webview (spec §7.1). **`fluentd`** is the background
  daemon owning PTY sessions, credentials, hardware/token tracking, and cross-agent coordination
  (spec §7.2).
- Every credential (subscription / platform API credits / API key) talks directly to its real
  provider — no Fluent-run backend, ever (spec §9).

## Where things live

- [`AGENTS.md`](./AGENTS.md) — product, brand, vocabulary.
- [`docs/superpowers/specs/2026-09-13-fluent-code-design.md`](./docs/superpowers/specs/2026-09-13-fluent-code-design.md) — the spec.
- [`design/`](./design/) — pen.dev source + PNG previews, source of truth for UI.
- [`src/`](./src/) — `daemon.ts` / `daemon-protocol.ts` / `daemon-client.ts` / `session-manager.ts`
  are the real `fluentd`, keep building on them. `index.tsx` / `theme.ts` are the superseded Ink
  prototype (spec §7.4) — port their RPC wiring to the Tauri frontend, not their JSX.
