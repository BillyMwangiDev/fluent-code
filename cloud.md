# Runtime and cloud boundary

Fluent Code has no Fluent-hosted service. The desktop app talks to a local `fluentd` process over
a Unix-domain socket; provider CLIs then talk directly to Claude Code, Codex, or an explicitly
configured OpenRouter-compatible endpoint. Fluent does not proxy model traffic, store API keys in
a Fluent backend, or export telemetry.

## Local runtime

- The default socket is `$XDG_RUNTIME_DIR/fluent-code.sock`, falling back to
  `/tmp/fluent-code.sock`. Set `FLUENT_SOCKET` on both the app/client and daemon to use another
  path. The daemon sets the socket to owner-only mode (`0600`).
- `FLUENT_STATE_DIR` selects the daemon-state directory; otherwise state is project-local
  `.fluent/`. It can contain credential metadata (never key material), coordination data, usage
  snapshots, remote profiles, OpenDesign origin, evaluation results, and verification state.
- API keys are stored with the operating system's credential store. Do not put keys in
  `.fluent/`, remote profiles, logs, or documentation.
- Claude-session observability writes additive managed hooks and, when absent, a status line to
  `<project>/.claude/settings.json`. This is a repository change to inspect before committing.

## Remote access

Remote support is an SSH Unix-socket forward, not a hosted control plane. A saved profile runs
`ssh -N -L <local socket>:<remote socket> <host>` and the desktop can select that forwarded daemon.
Its profile default is `/tmp/fluent-code.sock`; if the remote daemon uses `XDG_RUNTIME_DIR`, set
the profile's remote-socket field to that daemon's actual socket path instead.
Use SSH host configuration, key management, and host verification appropriate to your environment.
Never forward a Fluent socket over an unauthenticated TCP listener: the RPC is privileged and has
no separate network authentication layer.

Remote profiles validate their bounded SSH destination and remote Unix-socket path, then require a
versioned Fluent daemon handshake before the desktop can select the forward. A user can opt into
bounded automatic tunnel recovery; a direct disconnect cancels it. Windows forwarding, credential
broadcast, and a full remote observability UX remain incomplete. Remote profile metadata is local state and
may reveal hostnames or topology; treat the state directory accordingly.

## Security posture and open work

The daemon is intentionally a same-user local control plane. It can run provider commands, manage
credentials, manipulate Fluent worktrees, and use configured provider extensions. The catalog
screen confirms each user-initiated installation, but the RPCs still need daemon-side input
validation and a trusted-source policy. The Tauri content-security policy is also not yet locked
down because the Design workspace embeds a user-run loopback service. Both boundaries must be
completed before treating third-party extensions or embedded remote content as production-safe.
