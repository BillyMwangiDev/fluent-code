# OpenDesign connector

Fluent connects to a user-run instance of [OpenDesign](https://open-design.ai/official/) as an optional, local design workspace. The canonical upstream project is [`nexu-io/open-design`](https://github.com/nexu-io/open-design), released under Apache-2.0.

## Scope

- Fluent stores only a loopback OpenDesign **origin** (default `http://127.0.0.1:7456`) and probes
  it from `fluentd`. Paths, query strings, fragments, and URL credentials are deliberately not
  retained, so a custom health-check path cannot currently be configured.
- When reachable, the Design workspace can show OpenDesign in its existing desktop surface and creates Fluent coordination tasks for build handoff. A task can carry a repo-relative source mapping, component and token notes, a loopback preview URL, intended implementation paths, and an explicit reviewer handoff. Intended paths only become claims when the user selects an active owner lane and requests that reservation.
- OpenDesign remains its own local service. It owns its agents, model credentials, and design-file protocol; Fluent does not install it, start it, proxy its traffic, or copy its code.

## Boundary

The connector accepts only `localhost`, `127.0.0.1`, or `[::1]` HTTP(S) origins. For a remote
machine, run OpenDesign beside the remote Fluent daemon and use an authenticated tunnel before
extending this connector. This keeps a locally configured design service from becoming an arbitrary
network request channel. The Tauri content-security policy permits Fluent assets plus loopback
HTTP(S) connections and frames; it does not permit non-loopback design origins.

## Completion check

The first connector is complete when a developer can configure a local OpenDesign URL, see its health state, open it in Fluent's Design workspace, and create a repository-bound structured handoff task. Deeper file-level handoff should use OpenDesign's stable public API once it is documented upstream.

## CLI and MCP discovery

Fluent detects `pen` and OpenDesign's `od` CLI. The macOS system `od` command is deliberately rejected because it is an octal-dump utility, not OpenDesign. `od mcp install claude` and `od mcp install codex` are available as an explicit, confirmed action in Fluent. pen.dev’s local MCP server is controlled by its desktop Settings → MCP, so Fluent reports that state and does not attempt to edit its configuration files.
