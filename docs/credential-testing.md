# The three credential paths

Spec §9 gives every provider three independently connectable auth modes. This records how each one
is actually selected, verified against Claude Code 2.1.270 rather than assumed.

## What the CLI itself says

`claude auth login --help` is the authority:

```
--claudeai   Use Claude subscription (default)
--console    Use Anthropic Console (API usage billing) instead of Claude subscription
```

So **a subscription and platform API credits are both OAuth logins.** Neither is an API key, and
neither can be selected with an environment variable. `claude auth status --json` reports
`authMethod: "oauth_token"` for both.

The CLI holds **one login per config directory**, and `CLAUDE_CONFIG_DIR` moves that directory
(verified: setting it changes the `configDirectory` field `auth status` reports). That is what lets
Fluent keep a subscription and a credits account connected at the same time instead of treating
them as one.

## How Fluent selects each mode

`CredentialBroker.resolveEnv` returns what to **set** and what to **unset**; `applyCredentialEnvironment`
in `session-manager.ts` applies both.

| Mode | Set | Unset | Why |
|---|---|---|---|
| `subscription` | `CLAUDE_CONFIG_DIR=<state>/auth/claude/<id>` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | Its own OAuth login, un-shadowed by anything in the user's shell. |
| `platform-credits` | `CLAUDE_CONFIG_DIR=<state>/auth/claude/<id>` | same | The same mechanism, a different login (`--console`). |
| `api-key` (Claude) | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL` | `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CONFIG_DIR` | A key is meant to win over any OAuth login. |
| `api-key` (OpenRouter preset) | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` | Bearer-token auth. The key variable is **removed**, not blanked — an empty value is still a value the CLI can prefer. |
| `api-key` (Codex) | `OPENAI_API_KEY` | — | Unconfirmed against a real Codex install. |

The `unset` half is not decoration. A key exported in the user's shell is inherited by the daemon
and would otherwise reach every lane, including lanes Fluent deliberately put on a different
account — the app would name one credential while the session used another.

## Connecting an account

Fluent never runs the login: it is an interactive browser flow, and spec §9 keeps credentials the
user's business with their provider. The credentials screen shows the exact command instead, per
account:

```
CLAUDE_CONFIG_DIR=<state>/auth/claude/<id> claude auth login --claudeai   # subscription
CLAUDE_CONFIG_DIR=<state>/auth/claude/<id> claude auth login --console    # platform credits
```

An API-key account is pasted rather than logged into, so it has no command.

## Status

- **Subscription — in use, and the mechanism is now explicit.** Previously a subscription account
  set nothing at all, which meant it silently shared the default login with platform credits.
- **Platform credits — implemented, untested.** The mechanism is the same as subscription's with a
  different login flag, so it is far more likely to be right than the previous fall-through, but no
  credited account has been used.
- **API key — implemented, untested end to end.** Unit-tested only; no real key has been used.

## What to check when credits or a key arrive

1. **Connect it:** run the command the credentials screen shows for that account, then confirm the
   row flips to `connected · oauth_token` (or `api_key`).
2. **Both at once:** connect a subscription and a credits account, start a lane on each, and
   confirm each provider-side usage report moves for the right account. This is the case the
   config-directory split exists for.
3. **No shadowing:** `export ANTHROPIC_API_KEY=...` in the shell that starts `fluentd`, then run a
   subscription lane and confirm it still runs on the subscription.
4. **Fallback:** exhaust the first credential, confirm the chain moves on, the notice names the
   real cost (R4), and it reverts when the window resets.
5. **Evals bill the right account:** on an API key, `--max-cost-usd` becomes a real ceiling and the
   reported `costUsd` should be non-zero. On a subscription both stay at zero — expected, not a
   bug, which is why the UI asks in run counts there.
6. **Codex's key path:** `OPENAI_API_KEY` is the assumption; confirm it against an installed Codex.
