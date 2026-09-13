# Fastest cross-provider agent orchestrator

## Position

Fluent cannot make a provider model generate tokens faster. A credible fastest claim is narrower:
Fluent adds no material latency to a direct session and reduces time to a verified outcome through
provider-native transports, warm environments, low-conflict parallelism, and a closed build/design/
visual-check loop. Every claim must name provider version, model, corpus, machine, and metric.

## Local control-plane measurement

Measured on 2026-09-13 on one developer machine, against a temporary Fluent daemon socket and
state directory, with no provider request. The direct-ping row is 1,000 sequential client/server
round trips over Unix-domain IPC; it includes a fresh connection and JSON encode/decode, but not a
long-lived UI subscription or rendering. The two status rows are fresh child-process invocations.
The original raw samples, machine/OS/Node metadata, and harness are not retained, so these are
diagnostic measurements—not reproducible performance evidence or a release gate:

| Measure | Runs | Mean | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| In-process Unix-socket `ping` | 1,000 | 0.070 ms | 0.049 ms | 0.135 ms | 0.288 ms |
| Fresh compiled client status request | 80 | 72.8 ms | — | — | — |
| Fresh `pnpm`/`tsx` status request | 50 | 445.0 ms | — | — | — |

The direct-ping row shows that local IPC is unlikely to dominate a provider turn. It does not show
end-to-end Fluent overhead. The startup rows explain why the production UI must keep a compiled,
long-lived connection. None of these figures measure time to first token, model latency, tool
latency, UI rendering, or task completion. Those need authenticated, matched provider runs and
must never be inferred from a local ping.

## Current blockers

Fluent has real PTY sessions, streaming, credential isolation, worktrees, verification, merge
planning, coordination, quota observation, an OpenDesign loopback profile and local-preview
foundations. But it lacks the evidence and control plane required for a fastest claim:

- no normalized event trace for session-ready, prompt queued, provider first event, first tool,
  tool duration, first artifact, verification, integration, recovery, or completion;
- only two provider IDs; OpenRouter is a Claude compatibility preset rather than a third runtime;
- Codex app-server is a quota side channel, not the primary execution adapter; Claude is PTY plus
  hooks; therefore provider parity is currently false;
- no task DAG, critical-path scheduler, durable checkpoint/recovery model, or calibrated throughput
  allocator; claims are advisory and conflict resolution is manual;
- Design workspace begins with an OpenDesign loopback profile and tasks, not source/DOM mapping,
  console/network capture, screenshot baseline, visual diff, accessibility evidence, or a
  mismatch-to-agent loop.

## Provider constraints and opportunities

Codex app-server exposes a versioned, bidirectional JSON-RPC-style interface for threads, turns
and items, structured streaming, approvals, auth and skills.^1 Fluent currently launches that
interface over stdio and only reads quota; it must negotiate the installed schema before using it
to drive turns. Transport, queue and overload behavior must be established by compatibility tests
for each supported Codex version rather than assumed from a generic adapter contract.

Claude Code print mode supports JSON and `stream-json`; its hooks cover lifecycle, tool,
worktree, subagent, task, compaction and permission events.^2 ^3 This supports a structured
headless short-task path and lifecycle telemetry, but hooks must remain short because they can be
on an agent's critical path.

Gemini CLI headless mode exposes JSON/JSONL message, tool, result, error, usage and API-latency
events; its extensions support hooks, skills, preview subagents and policy controls.^4 ^5 It is a
candidate **only if Fluent deliberately expands beyond its currently supported Claude/Codex
provider scope**. It then needs credential-chain, onboarding, approvals, persistence, worktree,
telemetry and benchmark parity before being considered first class.

## Required product capabilities

1. **Versioned provider adapter contract.** Normalize start/resume/fork/cancel, durable session
   identity, ready/TTFT/text/tool/approval/usage/checkpoint/error/done events, model/sandbox/
   credential controls, and headless versus interactive execution. Retain a clearly labelled PTY
   fallback when a structured protocol is unavailable; report unavailable timestamps rather than
   treating them as a performance win.
2. **Durable run plane.** Make run, task, lane, attempt, checkpoint, artifact, verification and
   integration durable local entities. Reattach to provider-native sessions after app/network loss;
   never replay a prompt to simulate recovery. Harden the existing SSH Unix-socket-forwarding
   preview with authentication, protocol compatibility and reconnect diagnostics;
   a remote Fluent service is a separate future architecture decision.
3. **Speed-aware scheduling.** Use explicit micro, feature, long-running and parallel classes.
   Micro work gets a warm bounded headless path. Features use a dependency DAG and critical-path
   order. Long tasks checkpoint, resume and expose blocked/approval states. Parallel lanes are
   allocated by measured throughput, contention, cache warmth, CPU/disk/network and quota—not a
   fixed agent count.
4. **End-to-end build loop.** Detect project recipes; manage install/dev/test/build; run an isolated
   browser/device harness; capture route, console, network, a11y and screenshot evidence; pass
   bounded evidence to the next lane.
5. **Design-to-build loop.** Define repository-native tokens/components/screens/acceptance states.
   Use stable Pen/OpenDesign APIs, source/DOM mapping, screenshot baselines, semantic and pixel
   comparison, and a constrained mismatch-to-agent handoff. An iframe alone is not a handoff.
6. **Low-latency safety.** Use native provider policy/approval controls, then offer one Fluent
   approval queue with precise scope. Never bypass approval to improve a benchmark. Claude can
   block via `PreToolUse`; Gemini policy can remove denied tools from the model's tool set.^3 ^6

## Benchmark required before claiming fastest

Use the same provider CLI/version/model, credential mode, repository commit, prompt, sandbox and
approval policy for bare and Fluent arms. Record monotonic timestamps for worktree start/end,
session ready, prompt sent, first provider event, first text/tool, each tool duration,
verification and integration. Record hardware, network/remote host, provider quota, cache state,
lane count and feature flags.

| Work class | Primary measure | Required quality guard |
| --- | --- | --- |
| Short task | time to verified patch; success by deadline | independent tests and diff review |
| Long task | time to accepted integration; success rate | checkpoint/retry/rework/merge-conflict rate |
| Full app | time to build + acceptance + visual approval | route/a11y/network/visual evidence |
| Team | accepted-task throughput | critical path, duplicate work, cost and reviewer delay |

Run paired tasks in randomized order, stratified by task difficulty, with resettable repository
fixtures. Block cold/warm cache and provider time window, equalize account/rate-limit/concurrency
state, and report median/p95/confidence intervals plus failures, timeouts and rate limits. Pin
dependency, browser/device, viewport and network conditions; state whether human approval and
reviewer delay are included. Record per-run provider-reported token and cost data, trace
redaction/retention and consent, and enough trials for the selected confidence method. Compare
equivalent worktree, sandbox and approval policies—not only the same provider/model/prompt.
Separate worktree/cache launch gains from model speed. Publish every failed run.

Initial falsifiable targets: added median prompt-to-first-provider-event no greater than both 1%
of the bare-arm median **and** 100 ms for a supported structured adapter; under 250 ms p95 local
control-plane command latency; and at least 20% lower median time-to-verified outcome, with no
lower success rate and no statistically meaningful increase in total provider-reported cost, on a
published independent-task suite. The local measurement does not clear the p95 command target
because no p95 was retained. Valid data does not yet exist for the model-turn or verified-outcome
claims.

## Delivery order

1. Daemon-enforced risky-action approval, secure/redacted persistence, trace envelope and
   reproducible benchmark harness/corpus.
2. Codex protocol-discovery gate followed by a full app-server adapter only where its installed
   version proves compatible; then Claude structured/headless adapter and explicit PTY fallback.
   Evaluate Gemini only after a separately approved provider-scope expansion.
3. Warm sessions, direct event-to-UI rendering, per-cache-class worktrees and prompt queues.
4. Durable checkpoints/recovery, DAG scheduler, capability-safe context packs and calibrated
   admission.
5. Managed preview/browser evidence behind recipe trust plus Tauri capability/CSP hardening, then
   the repository-native design/visual approval loop.
6. Continuous public benchmark publication with distributions, cost, failures and environment.

## Sources

1. OpenAI, [codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), accessed 2026-09-13.
2. Anthropic, [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage), accessed 2026-09-13.
3. Anthropic, [Hooks guide](https://code.claude.com/docs/en/hooks-guide) and [Permissions](https://code.claude.com/docs/en/permissions), accessed 2026-09-13.
4. Google, [Gemini CLI headless mode reference](https://geminicli.com/docs/cli/headless/), accessed 2026-09-13.
5. Google, [Gemini extensions reference](https://geminicli.com/docs/extensions/reference/) and [hooks reference](https://geminicli.com/docs/hooks/reference/), accessed 2026-09-13.
6. Google, [Gemini policy engine](https://geminicli.com/docs/reference/policy-engine/), accessed 2026-09-13.
