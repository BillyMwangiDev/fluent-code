# Fluent Code

Desktop orchestration for Claude Code, Codex, and OpenRouter-backed coding agents — `fluentd`
owns real PTY sessions and a credential broker; `fluent` is a Tauri app that renders and
coordinates them. See [`docs/superpowers/specs/2026-09-13-fluent-code-design.md`](docs/superpowers/specs/2026-09-13-fluent-code-design.md)
for the full design; this file covers the desktop implementation that exists today and calls out
the remaining product gaps explicitly.

## Run it

```sh
pnpm install
pnpm daemon
```

In another terminal:

```sh
pnpm tauri dev
```

`fluentd` owns provider processes, so closing the app window does not stop a running session —
check what's still running with `pnpm daemon:status`. The Tauri app talks to `fluentd` only over
its Unix socket (`/tmp/fluent-code.sock` by default; override both sides with `FLUENT_SOCKET`);
there is no other channel between them.

First run: the splash screen routes you to onboarding if no provider account is connected yet.
"Connect via CLI login" opens a real `claude` session in the app so you complete auth through the
CLI's own flow (Fluent never reimplements login); "API key" saves a credential straight to
`fluentd`. From there: **sessions** lists what's running, **new session** starts one, and
**credentials** manages the precedence chain and fallback policy for when one hits a usage limit.

**Current limitations**, called out here rather than left silent:
- Claude Code and Codex launch as their real installed CLIs. OpenRouter is a Claude Code
  compatibility preset, not a separate agent executable.
- `.fluent/credentials.json` stores only account metadata, precedence, and fallback state.
  API-key material is held in the OS credential store under its provider/account id and is never
  returned by the daemon's credential-list RPC.
- Provider approval prompts are still rendered by the underlying CLI; Fluent does not yet turn
  them into structured, cross-provider approval cards.
- The usage screen has live local CPU, memory, disk, uptime, and session signals. It deliberately
  does not fabricate token, cache, quota, or cost data while provider adapters lack an official
  telemetry signal.
- SSH remote profiles forward a remote `fluentd` Unix socket and can become the active desktop
  target. Remote setup, credential broadcasts, and reconnect recovery still need fuller UX.
- The Design workspace can optionally embed a user-run local [OpenDesign](https://open-design.ai/official/)
  service at `127.0.0.1:7456`. The connector is intentionally loopback-only and does not yet
  perform file-level OpenDesign API handoff; it creates repository-bound Fluent handoff tasks.
- The Design workspace also discovers the `pen` and OpenDesign CLIs. It can run OpenDesign's
  documented MCP installer for Claude Code or Codex only after an in-app confirmation; pen.dev’s
  local MCP toggle remains owned by the pen.dev desktop app.
- Coordination stores tasks, claims, decisions, and handoffs, but claims are advisory and there
  is no diff-review or automated conflict-resolution workflow yet. New sessions can opt into a
  detached Git worktree, which is only removable after its session stops.

## Architecture

```
fluentd   src/daemon.ts et al. — Node, owns PTY sessions (node-pty), the credential broker,
          and the hooks relay. Newline-delimited JSON-RPC over a Unix socket.
fluent    src-tauri/ (Rust) + app/ (vanilla TS/HTML, esbuild-bundled, no framework) — a Tauri
          window. Rust holds the only fluentd connection; the webview never talks to the socket
          directly. xterm.js renders the text fluentd already captures.
```

`fluentd`'s RPCs: `ping`, `sessions.{list,create,get,send,stop,resize,subscribe,unsubscribe}`,
`credentials.{list,upsertAccount,setChain,setFallbackPolicy,confirmFallback}`, `hooks.report`
(fed by Claude Code's own hooks via `dist/hook-relay.js`, never by parsing terminal output — see
the design spec §7.5). `sessions.subscribe`/`stream.open` keep their socket open and push
`sessions.output` / `sessions.status` / `credential.switched` / `credential.notice` events;
every other method is a plain one-shot request/response.

Run `pnpm build` at least once before real hook usage — `hooks-config.ts` points Claude Code's
hooks at the *compiled* `dist/hook-relay.js` (it has to; Claude Code invokes it with plain `node`,
never `tsx`), so a hooks-dependent feature (credential fallback triggered by a real rate limit)
won't fire until that build exists.

## Other useful commands

- `pnpm check` / `pnpm run check:frontend` — typecheck the daemon and the app frontend separately
  (two independent TS projects; the frontend has no Node-only dependencies).
- `pnpm run build:frontend` — rebuild `app/dist/{main.js,main.css}` from `app/src/`; `tauri dev`
  and `tauri build` already do this via `beforeDevCommand`/`beforeBuildCommand`.

## Superseded prototype

`src/index.tsx` and `src/theme.ts` are the original Ink/terminal-native prototype (`pnpm dev` /
`pnpm start`) that the Tauri app above replaced — kept only as reference for the daemon-RPC
wiring it already had right; not the current way to run Fluent Code.

## Design source

The editable product design lives in [`design/pen/fluent-code.pen`](design/pen/fluent-code.pen). See [`design/README.md`](design/README.md) for screen-to-export mapping and implementation constraints.
