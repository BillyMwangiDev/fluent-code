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
- [`docs/research/2026-09-13-agent-orchestration.md`](./docs/research/2026-09-13-agent-orchestration.md) —
  orchestration research (field survey + sourced findings) and the ranked recommendations that
  come out of it. Read alongside the spec before changing the coordination or credential layers.
- [`design/`](./design/) — pen.dev source + PNG previews, source of truth for UI.
- [`src/coord-cli.ts`](./src/coord-cli.ts) — `fluent-coord`, the coordination surface the *agents*
  use (status / claim / release / note / task / handoff). A CLI rather than an MCP server on
  purpose: every agent already has a shell, so it works on every provider with nothing to install
  per lane. Lanes are told it exists two ways — a short always-on briefing through each CLI's own
  direction flag ([`src/agent-briefing.ts`](./src/agent-briefing.ts)), and the `fluent-collab`
  skill ([`src/collab-skill.ts`](./src/collab-skill.ts)) installed into *both* providers' user
  skill directories, which is what lets a Codex lane and a Claude lane collaborate as peers.
- [`plugin/fluent-collab/evals/`](./plugin/fluent-collab/evals/) — the eval suite for the
  collaboration skill, run by [`src/eval-runner.ts`](./src/eval-runner.ts) through Claude Code's
  built-in `claude plugin eval`. Tests prove `fluent-coord` works; evals measure whether an agent
  actually *uses* it, scored with and without the skill. `pnpm evals:check` validates the suite for
  $0 (CI-safe); `pnpm evals` runs it for real and costs money on your own credential.
- [`docs/credential-testing.md`](./docs/credential-testing.md) — how each of spec §9's three auth
  modes is actually selected, verified against Claude Code's own `auth` surface. The key fact:
  subscription and platform credits are *both* OAuth logins (`--claudeai` vs `--console`), so they
  are told apart by `CLAUDE_CONFIG_DIR`, not by an env var. Only subscription is proven end to end;
  the doc lists what to check when credits or a key arrive.
- [`src/`](./src/) — `daemon.ts` / `daemon-protocol.ts` / `daemon-client.ts` / `session-manager.ts`
  are the real `fluentd`, keep building on them. `index.tsx` / `theme.ts` are the superseded Ink
  prototype (spec §7.4) — port their RPC wiring to the Tauri frontend, not their JSX.
