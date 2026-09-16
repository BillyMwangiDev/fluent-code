# Fluent Code

Fluent runs your real Claude Code, Codex, Gemini CLI, and OpenCode-linked (Qwen, GLM, NVIDIA)
CLIs as unmodified processes, and adds what none of them do alone:

- **Falls back on limits.** When a credential hits its usage limit, Fluent switches the lane to
  the next credential in your chain automatically, with notice and an auto-revert timer.
- **Stops at a budget.** Set a dollar cap on a lane and Fluent stops it the moment its cost
  reaches that figure.
- **Shows limits and cost.** A limits strip reports each credential's 5-hour and 7-day usage
  window; every lane tile shows its running cost.

On top of that: parallel lanes on the same project, git-worktree isolation per lane, and
cross-agent coordination — a shared task board, file claims, handoffs — so agents working the
same project don't collide.

`fluentd` owns the real PTY sessions and the credential broker; `fluent` is a Tauri app that
renders and coordinates them. See [`docs/superpowers/specs/2026-09-13-fluent-code-design.md`](docs/superpowers/specs/2026-09-13-fluent-code-design.md)
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
an owner-local IPC endpoint: a Unix socket (`$XDG_RUNTIME_DIR/fluent-code.sock`, or
`/tmp/fluent-code.sock`) on macOS/Linux, or a per-user Windows named pipe. Override both sides
with `FLUENT_SOCKET` (and optionally set `FLUENT_PIPE_NAME` on Windows). There is no other channel
between them.

Fluent finds CLIs the way your terminal does: the daemon adopts your login shell's `PATH` (plus the
usual installer directories such as `~/.local/bin` and Homebrew) even when the app was launched from
Finder or the Dock. A provider that is not installed gets an **install** button in the launch sheet
and the design workspace; it runs the vendor's own installer (Claude Code, Codex and OpenCode ship
native installers that need neither Node.js nor Homebrew) only after you have seen and approved the
exact command, and shows the installer's output if it fails. Gemini CLI and the pen.dev CLI ship
only through Homebrew or npm, so those need one of the two present first.

First run: the splash screen routes you to onboarding if no provider account is connected yet.
"Connect via CLI login" opens a real `claude` session in the app so you complete auth through the
CLI's own flow (Fluent never reimplements login); "API key" saves a credential straight to
`fluentd`. From there: **sessions** lists what's running, **new session** starts one, and
**credentials** manages the precedence chain and fallback policy for when one hits a usage limit.

**Current limitations**, called out here rather than left silent:
- Claude Code, Codex, and Gemini CLI launch as their real installed CLIs. Qwen, GLM, and NVIDIA
  NIM accounts launch through a locally installed [OpenCode](https://opencode.ai/) adapter with an
  account-specific OpenAI-compatible endpoint and model. Fluent passes the selected API key only
  to that child process; it never writes the key into OpenCode config. OpenRouter is a Claude Code
  compatibility preset, not a separate agent executable. Gemini's Google login and Vertex
  credentials remain owned by Gemini CLI; Fluent supports the explicit `GEMINI_API_KEY` account
  path without copying browser or ADC credentials.
- `.fluent/credentials.json` stores only account metadata, precedence, and fallback state.
  API-key material is held in the OS credential store under its provider/account id and is never
  returned by the daemon's credential-list RPC.
- Provider approval prompts are still rendered by the underlying CLI; Fluent does not yet turn
  them into structured, cross-provider approval cards.
- The usage and spend screens read local provider transcripts and provider-reported status data.
  They show tokens, cache fields, reported cost, and quota only where the provider emits them;
  missing values mean unavailable data, not zero. Transcript-derived totals can include sessions
  started outside Fluent and are estimates, not billing records.
- SSH remote profiles forward a remote `fluentd` Unix socket and can become the active desktop
  target. Profile inputs are validated, the forward must answer a versioned Fluent handshake, and
  a user may opt into bounded automatic tunnel recovery; direct disconnect always cancels it.
  Windows remote forwarding and remote credential broadcasts still need fuller UX.
- The Design workspace can optionally embed a user-run local [OpenDesign](https://open-design.ai/official/)
  service at `127.0.0.1:7456`. The connector is loopback-only and opens the exact origin a user
  saved in a dedicated guarded webview; redirects and other local ports remain blocked. It does
  not yet perform file-level OpenDesign API handoff. Its repository-bound Fluent handoff tasks do
  persist the source mapping, component and token notes, loopback preview, intended implementation
  paths, and any explicitly requested reviewer handoff.
- The Design workspace also discovers the `pen` and OpenDesign CLIs. It can run OpenDesign's
  documented MCP installer for Claude Code or Codex only after an in-app confirmation; pen.dev’s
  local MCP toggle remains owned by the pen.dev desktop app.
- Coordination stores tasks, claims, decisions, and handoffs. Claims remain advisory; Fluent can
  observe changed paths, run project checks, predict merge conflicts, and serialize user-requested
  worktree integration, but it does not resolve conflicts automatically. New sessions can opt into
  a detached Git worktree, which is only removable after its session stops. Removing one first saves
  anything left uncommitted in it to a `refs/fluent-snapshots/` ref in the project, restorable with
  `git worktree add <path> <ref>`; Git-ignored files in it are still deleted. A project can list
  Git-ignored paths it wants copied into every new worktree — a `.env.local`, say — one per line in
  a `.worktreeinclude` file at its root.
- The catalog screen distinguishes native provider plugins from portable MCP servers. Native
  marketplace plugins remain host-specific; a structured MCP declaration and Fluent's
  collaboration skill can be installed at user scope across Claude Code, Codex, and Gemini CLI
  with one explicit approval. The daemon validates executable/argument/URL structure and can
  enforce a trusted-source policy for third-party extension sources.

## What it costs to run

Running agents in parallel costs more raw tokens than running one agent in one terminal, not
less. Anthropic's own multi-agent research post reports subagent runs at roughly 4x the tokens of
a single chat turn, and a full orchestrator-plus-parallel-workers run at roughly 15x (sourced,
with Claude Code's own Agent Teams figure, in
[`docs/research/2026-09-17-token-economics.md`](docs/research/2026-09-17-token-economics.md)).
Fluent doesn't hide that trade-off. The honest measure of an orchestrator is cost per completed
task, not cost per session — five lanes run in parallel can cost more in tokens than the same
work done serially and still be the cheaper way to get it done, or not, depending on how much
rework, merge conflict, and idle time it avoids. What Fluent reports today: a reported or
estimated dollar cost on every lane tile and on the spend page, a per-credential 5-hour/7-day
limit window so you can see what parallel lanes are spending against, and a per-lane dollar
budget that stops a lane before it runs away. It does not yet compute a cost-per-completed-task
figure or a serial-vs-parallel counterfactual — that needs attributing spend to task-board
outcomes, which isn't built.

## Desktop packaging

`pnpm run package:mac` produces a macOS `.dmg`; `pnpm run package:windows` produces a Windows
NSIS `.exe`. Both commands create `fluentd` and the resource monitor as Tauri sidecars before
assembling the installer. A release build therefore does not require a system Node installation,
and the packaged daemon locates the packaged monitor beside itself. Native terminal and credential
addons must be built on their matching target; the sidecar scripts deliberately reject a cross
compile rather than silently shipping host-native code. Build macOS on macOS and Windows on
Windows. The **desktop package checks** workflow runs both native builds and retains the test
installers as downloadable Actions artifacts for 30 days; it can also be started manually.

The local and CI artifacts are unsigned test installers: Gatekeeper refuses them on any other Mac
until they are signed and notarized. The build is wired for that — `src-tauri/Entitlements.plist`
carries the hardened-runtime entitlements the pkg-built `fluentd` needs (JIT, unsigned executable
memory, unsigned native addons) — so a signed, notarized dmg needs only a Developer ID Application
certificate in the login keychain and these variables set for `pnpm package:mac`:

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<TEAMID>)" \
APPLE_ID=<apple id> APPLE_PASSWORD=<app-specific password> APPLE_TEAM_ID=<TEAMID> \
pnpm package:mac
```

Check the result with `codesign -dv --verbose=2 "/Applications/Fluent Code.app"` (expect the
Developer ID authority and `runtime` among the flags) and `spctl -a -vv "/Applications/Fluent Code.app"`
(expect `accepted`, source `Notarized Developer ID`). A public release still also requires a Windows
code-signing certificate, clean-machine installation checks, and the provider-credential and
multi-lane smoke matrix.

The packaged app writes its logs to `~/Library/Logs/codes.fluent.desktop/`: `fluentd.log` is the
daemon's own output (rolled to `fluentd.log.1` past 5 MB) and `Fluent Code.log` the desktop shell's.

## Security and local data

`fluentd` is a local, owner-only Unix-socket service. It can start provider CLIs, manage account
metadata, create/remove Fluent worktrees, and invoke provider extension commands; do not expose
its socket through a shared directory or an unauthenticated network tunnel. API keys stay in the
OS credential store; `.fluent/` holds non-secret state such as credential metadata, remote
profiles, usage, coordination state, and OpenDesign configuration. Provider hooks add managed
entries to a project's `.claude/settings.json` when a Claude session is created, so review that
project-local change before committing it. See [`cloud.md`](cloud.md) for the runtime boundary and
remote-connection notes.

## Architecture

```
fluentd   src/daemon.ts et al. — Node, owns PTY sessions (node-pty), the credential broker,
          and the hooks relay. Newline-delimited JSON-RPC over a Unix socket (macOS/Linux) or a
          Windows named pipe.
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

For cross-runtime coordination, `fluent-coord` is the universal terminal fallback and
`fluent-coord-mcp` provides one compact MCP tool (`fluent_coord`). The tool resolves its lane from
the provider's working directory and reads/writes only the generated task/claim/mail summary; it
never injects other agents' terminal transcripts into context. The **install coordination bundle**
action writes a user-scoped `fluent-collab` skill and registers that MCP tool through each
provider's own CLI. Build once with `pnpm build` before installing it so hosts invoke the compiled
server.

Run `pnpm build` at least once before real hook usage — `hooks-config.ts` points Claude Code's
hooks at the *compiled* `dist/hook-relay.js` (it has to; Claude Code invokes it with plain `node`,
never `tsx`), so a hooks-dependent feature (credential fallback triggered by a real rate limit)
won't fire until that build exists.

## Other useful commands

- `pnpm check` / `pnpm run check:frontend` — typecheck the daemon and the app frontend separately
  (two independent TS projects; the frontend has no Node-only dependencies).
- `pnpm run build:frontend` — rebuild `app/dist/{main.js,main.css}` from `app/src/`; `tauri dev`
  and `tauri build` already do this via `beforeDevCommand`/`beforeBuildCommand`.
- `pnpm test:frontend` — the frontend's pure logic (launch plan, grid shape, ticket prompts).
- `node scripts/qa/shoot.mjs [outDir]` — screenshots of every route from the visual fixture;
  `node --import tsx scripts/qa/live.mts [outDir]` — the real bundle against a real, private
  fluentd with stand-in provider CLIs (launch, broadcast, focus, stop, session view).

## Superseded prototype

`src/index.tsx` and `src/theme.ts` are the original Ink/terminal-native prototype (`pnpm dev` /
`pnpm start`) that the Tauri app above replaced — kept only as reference for the daemon-RPC
wiring it already had right; not the current way to run Fluent Code.

## Design source

The editable product design lives in [`design/pen/fluent-code.pen`](design/pen/fluent-code.pen). See [`design/README.md`](design/README.md) for screen-to-export mapping and implementation constraints.
