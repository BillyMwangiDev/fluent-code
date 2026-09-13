# OpenDesign connector

Fluent connects to a user-run instance of [OpenDesign](https://open-design.ai/official/) as an optional, local design workspace. The canonical upstream project is [`nexu-io/open-design`](https://github.com/nexu-io/open-design), released under Apache-2.0.

## Scope

- Fluent stores only a loopback OpenDesign URL (default `http://127.0.0.1:7456`) and probes it from `fluentd`.
- When reachable, the Design workspace can show OpenDesign in its existing desktop surface and creates Fluent coordination tasks for build handoff.
- OpenDesign remains its own local service. It owns its agents, model credentials, and design-file protocol; Fluent does not install it, start it, proxy its traffic, or copy its code.

## Boundary

The connector accepts only `localhost`, `127.0.0.1`, or `[::1]` HTTP(S) origins. For a remote machine, run OpenDesign beside the remote Fluent daemon and use an authenticated tunnel before extending this connector. This keeps a locally configured design service from becoming an arbitrary network request channel.

## Completion check

The first connector is complete when a developer can configure a local OpenDesign URL, see its health state, open it in Fluent's Design workspace, and create a repository-bound handoff task. Deeper file-level handoff should use OpenDesign's stable public API once it is documented upstream.

## CLI and MCP discovery

Fluent detects `pen` and OpenDesign's `od` CLI. The macOS system `od` command is deliberately rejected because it is an octal-dump utility, not OpenDesign. `od mcp install claude` and `od mcp install codex` are available as an explicit, confirmed action in Fluent. pen.dev’s local MCP server is controlled by its desktop Settings → MCP, so Fluent reports that state and does not attempt to edit its configuration files.
