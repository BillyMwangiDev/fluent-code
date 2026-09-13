# Multi-runtime orchestration interoperability

Status: first interoperable execution slice complete; capability-matrix and durable-task work remain planned.

## Outcome

Fluent Code must let Claude Code, Codex, Gemini CLI, and future compatible agent runtimes work in
one project without copying full conversations between them. Each lane gets a small, durable view
of shared work (tasks, claims, decisions, handoffs, and mail), can use the same approved tools,
and can continue long-running work from durable state rather than replaying a prompt.

## Evidence gathered

- Fluent already has durable claims, ordered mail, handoffs, run events, approval records, and a
  small `fluent-coord` CLI. Its main interoperability gap is discoverability: Claude receives the
  coordination briefing, Codex does not, and Gemini is not a provider or extension target.
- [Official OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  recommends outcome-first instructions, explicit long-running state compaction, stable prompt
  prefixes for caching, tool-specific context only when it changes policy, and explicit tuning of
  delegation. It also documents asynchronous tool calls and mid-turn steering as supported API
  capabilities, which belong behind a future structured-adapter capability boundary rather than a
  PTY assumption.
- [Anthropic's long-horizon guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
  recommends structured state, incremental progress, fresh-context recovery, and independent
  verification. It cautions that subagents should be reserved for independent or isolated work.
- [Gemini CLI documents](https://geminicli.com/docs/tools/mcp-server/) MCP tools, resources,
  prompts, user-scoped registration, and stdio/HTTP/SSE transports. Its
  [skills guide](https://geminicli.com/docs/cli/tutorials/skills-getting-started/) confirms
  user-scoped `~/.gemini/skills` discovery. Gemini's
  [authentication guide](https://geminicli.com/docs/get-started/authentication/) documents
  `GEMINI_API_KEY` for headless/API-key use and interactive Google login for local CLI sessions.
- The current [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  supports typed input/output schemas and long-running task support. It says clients must treat
  server-provided annotations as untrusted, so Fluent must keep its daemon approval boundary even
  when a tool declares itself safe.

## Decisions

1. MCP is the portable capability boundary. Native Claude/Codex/Gemini plugins are not portable
   artifacts and cannot truthfully be installed "across every agent." Fluent will batch-install
   portable MCP and SKILL.md bundles to each supported host, while preserving each host's native
   plugin catalog as a provider-specific capability.
2. `fluent-coord` remains the universal fallback because every coding agent can run a command.
   Fluent also exposes it as one compact `fluent_coord` MCP tool so participating hosts discover
   coordination without a long prompt or per-turn transcript injection.
3. The MCP tool returns concise, generated-on-demand state. It never mirrors terminal output,
   secrets, other projects' mail, or a full shared transcript. Stable skill text is loaded only
   when relevant, preserving provider prompt caches.
4. Gemini joins the provider registry as a real CLI lane and API-key account path. Google-login
   and Vertex/ADC remain owned by Gemini CLI; Fluent does not copy browser tokens or service
   account material.
5. Long-running control stays in Fluent's durable RunStore. A future structured provider adapter
   may add resume/steer/checkpoint only after its documented acknowledgement and deduplication
   contract is probed. PTY input stays `delivery_unknown` after a crash and is never replayed.

## First implementation slice

1. Add Gemini CLI to the provider registry and its explicit `GEMINI_API_KEY` credential
   environment, preserving the user's own interactive Gemini login.
2. Extend the collaboration skill to Claude, Codex, and Gemini user scopes.
3. Add a dependency-free stdio MCP server, `fluent-coord-mcp`, with a single schema-validated
   coordination tool. It maps to existing daemon RPCs, uses the lane's working directory as
   identity, and returns compact text/structured results only.
4. Add an approved installer/status path that registers the local MCP tool at user scope for every
   installed supported host. A failed or unavailable host is reported independently; one host does
   not block the others.
5. Make MCP catalog entries structured (transport, executable, args, URL, scope) and install one
   portable server to one or many supported providers without shell-string splitting. Keep native
   plugin installs provider-specific and show that distinction in the UI.
6. Add protocol and installer tests, then run the daemon, frontend, and full test suites.

## Follow-on work

- Build a `ProviderAdapter` capability matrix for structured headless paths, provider acknowledgements,
  quotas, resume, interruption, and permission events. Do not claim parity until a real versioned
  probe passes.
- Add task/DAG context packs with a fixed token budget, source IDs, expiry, and secret scan.
  Send deltas only at a safe provider acknowledgement boundary; interactive PTYs receive a
  viewable pack and are never implicitly written to.
- Add extension lockfiles and capability attestations so a user can review exactly which MCP/skill
  bundle is portable, which host-specific plugin will be installed, its version/hash, granted
  tools, and approval receipt.
- Measure turn and integration quality per provider with the phase-0 benchmark harness. Speed
  claims require paired results and should report cache, approval, queue, and verification time
  separately.

## Delivery receipt — 2026-09-13

Implemented the first slice exactly at the portable boundary:

- Gemini CLI is a launchable provider and supports the explicit `GEMINI_API_KEY` account path.
  Its interactive Google-login and Vertex/ADC flows remain provider-owned.
- `fluent-collab` now installs in user scope for Claude, Codex, and Gemini. The coordination bundle
  also registers the compiled `fluent-coord-mcp` through each host CLI. It reports each host's
  result independently rather than pretending a missing runtime was configured.
- `fluent-coord-mcp` implements a compact stdio MCP server with a single `fluent_coord` tool. It
  delegates to the existing daemon's lane-authenticated RPCs, identifies the lane from its working
  directory, and returns only generated coordination text. It does not persist prompts, terminal
  output, or unrelated project state.
- The catalog now models MCP registrations as structured transport/executable/argument/URL data,
  validates it, and can install a user-scoped portable server across Claude, Codex, and Gemini.
  It deliberately leaves marketplace plugins host-specific rather than silently translating or
  executing an incompatible format.
- The desktop UI exposes Gemini onboarding and an all-supported-agents MCP target. Its
  coordination-bundle state distinguishes a current skill from an available MCP tool.

Verified with `pnpm check`, `pnpm check:frontend`, `pnpm test` (200 passing), `pnpm build`,
`pnpm build:frontend`, a compiled-MCP `initialize`/`tools/list` smoke test, and `git diff --check`.
