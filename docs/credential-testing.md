# Testing the three credential paths

Spec §9 gives every provider three independently connectable auth modes. Only one of them is
exercised today, so this records what is proven, what is not, and exactly what to check when the
other two become available.

## Where each mode is decided

`CredentialBroker.resolveEnv` (`src/credential-broker.ts`) is the whole mechanism: it returns the
environment overrides a session is spawned with, per spec §7.5's "inject via that CLI's own env
vars".

| Mode | What `resolveEnv` returns | Effect |
|---|---|---|
| `subscription` | `undefined` | The CLI uses its own OAuth login. |
| `platform-credits` | `undefined` | **Identical to subscription right now.** |
| `api-key` (Claude) | `ANTHROPIC_API_KEY`, plus `ANTHROPIC_BASE_URL` when set | The CLI talks to that endpoint with that key. |
| `api-key` (Claude via OpenRouter preset) | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, empty `ANTHROPIC_API_KEY` | Claude-family models only — see spec §14. |
| `api-key` (Codex) | `OPENAI_API_KEY` | Unconfirmed against a real Codex; spec §7.5 flags it. |

## Status

- **Subscription — in use.** Lanes and the eval runner both work on the CLI's own login.
- **Platform credits — untested, and currently indistinguishable from subscription.** This is the
  open question: if Anthropic Console credits are reached with a key rather than the CLI's OAuth
  login, then `resolveEnv` needs a `platform-credits` branch and the current fall-through is wrong.
  Decide this against a real credited account rather than by reasoning about it.
- **API key — untested end to end.** The code path is exercised by unit tests; no real key has
  been used.

## What to check when credits or a key arrive

1. **Does a lane actually run on the selected account?** Start a lane on the non-default account
   and confirm the provider's own usage reporting moves for that account, not the subscription.
2. **Platform credits: is a key involved at all?** If yes, add the `platform-credits` branch to
   `resolveEnv` and a test alongside the existing ones in `src/credential-broker.test.ts`.
3. **Does fallback do anything visible?** Exhaust the first credential and confirm the chain moves
   on, that the notice names the real cost (R4), and that it reverts when the window resets.
4. **Do the evals bill the right account?** `evals.run` passes `broker.resolveEnv('claude')` to the
   evaluator's child processes, so on an API key `--max-cost-usd` becomes a real ceiling and the
   reported `costUsd` should be non-zero. On a subscription both stay at zero; that is expected,
   not a bug, and the UI asks in run counts rather than dollars for exactly that reason.
5. **Codex's key path.** `OPENAI_API_KEY` is the assumption; confirm it against an installed Codex
   before relying on it.
