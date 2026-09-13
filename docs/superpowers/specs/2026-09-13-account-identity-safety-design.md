# Account identity & ToS-safety boundaries — design

Status: approved in brainstorming (2026-09-13). Not yet implemented in code — see §6/§7 for what
still needs building.
Companion docs: [main design spec](./2026-09-13-fluent-code-design.md) — §2, §7.5, §9, §11, §13
are the sections this amends without editing in place, the same convention
[the orchestration research doc](../../research/2026-09-13-agent-orchestration.md) already uses —
and that research doc's R8 (race mode), whose guardrail this tightens.

**The question this answers:** Fluent Code runs multiple AI-provider CLIs, under multiple
credentials, concurrently, on the user's behalf. Which of those shapes are the providers' own
terms of service actually fine with, which is the specific pattern their abuse/fraud enforcement
targets, and how does the credential broker — already built — and future parallel-orchestration
work (R8) need to change so that ambitious orchestration never quietly becomes the thing that gets
an account suspended?

**Method.** Grounded in the current Anthropic Consumer Terms (§2 account sharing, §3.7 automated
access) and OpenAI's Services Agreement / usage-policy guidance, both checked directly against
current web sources rather than assumed, plus how Claude Code itself already handles multi-account
login (`CLAUDE_CONFIG_DIR` per account, confirmed community usage). Read alongside
`src/daemon-protocol.ts`'s `CredentialAccount` / `CredentialChainState` and `src/credential-broker.ts`,
which is the code §6 of this doc changes.

---

## 0. The short version

Two patterns already in the shipped v1 credential broker are fine and need no change: (a)
automatic fallback across one login's own billing tiers (subscription → its own platform credits →
its own API key), and (b) many concurrent lanes on one login from one machine. One pattern is a
real gap in already-shipped code: `CredentialAccount` (`src/daemon-protocol.ts:389`) has no concept
of "identity" — a second login of the same provider added to a provider's chain would be silently
treated as just another rung in the same automatic fallback ladder, indistinguishable from (a), but
actually the "switched accounts to dodge a rate limit" shape both providers' enforcement describes.
This doc adds the missing concept and draws the line before it's built into a UI.

---

## 1. What's already safe, and why (no code change)

### 1.1 Same-identity, cross-tier fallback

Anthropic and OpenAI both build a pay-as-you-go tier specifically as the overflow for when a
subscription's flat included usage runs out, billed to the same login. Auto-switching from
subscription to platform credits (or an API key) *on that same login* when a limit is hit is using
the product exactly as designed — not evasion of anything, because the account is simply paying for
more usage the moment the included bucket is empty. `credential-broker.ts`'s existing
`reportUsageLimit` / `confirmFallback` / auto-revert-timer loop, and the `always-ask` /
`always-switch` / `never-switch` policy on screen 10, stay exactly as built for this case.

### 1.2 Concurrency under one identity

Running several lanes concurrently on one login, from one machine, one IP, is the same shape as a
person running several terminal tabs against their own account — not the concurrent-access-from-
different-locations pattern that trips fraud detection (that pattern is specifically about
*sharing* a login across separate physical users). Claude Code's own documented multi-account
mechanism (`CLAUDE_CONFIG_DIR` pointed at a different folder per login, run in parallel terminals)
confirms concurrent same-login sessions are normal, supported usage. No design or code change
follows from this; the existing advisory hardware/quota nudges (spec §10, research doc R7) already
cover the practical (not compliance) side of "how many lanes can this machine/window actually
support."

### 1.3 The architectural invariant worth pinning down explicitly

The one bright-line rule the research turned up: Anthropic's Consumer Terms §3.7 exempts Claude
Code's own automation from the "no bots/scripts" clause, but separately and explicitly prohibits
using an OAuth token obtained through a Free/Pro/Max login in **any other product, tool, or
service — including the Agent SDK.** Fluent's credential broker already never touches a token: it
resolves an *environment* for a spawned process (`resolveEnv` in `credential-broker.ts`) and lets
the real `claude` / `codex` binary do its own login under that environment. It never reads, extracts,
or re-sends a session token itself. This is already true; it should be stated as a permanent
invariant in the main spec (§7.5) so a future change — e.g. a "fast path" that calls the provider's
API directly using a Pro/Max token to skip spawning the CLI — is recognized as a boundary violation
before it's built, not after.

---

## 2. The gap: credential chains have no identity concept

Today, `CredentialAccount` is:

```ts
export type CredentialAccount = {
  id: string;
  provider: ProviderId;
  mode: CredentialMode;       // 'subscription' | 'platform-credits' | 'api-key'
  label: string;
  hasSecret?: boolean;
  baseUrl?: string;
};
```

and `CredentialChainState.chain: string[]` is a flat, ordered list of account ids with one
`fallbackPolicy` governing the whole list. Nothing distinguishes "these two accounts are the same
login's own tiers" from "these two accounts are two different people's — or two different
subscriptions of the same person's — logins." If a user connects a second `subscription`-mode
account for the same provider (a second Claude Max login, say), today's data model would let it
join the same `chain`, and `always-switch` would auto-hop to it on a rate-limit hit exactly the same
way it hops from subscription to platform-credits. That specific behavior — switching *login
identities* because one hit its limit — is the pattern both providers' own enforcement language
calls out, independent of whether both logins are legitimately paid for by the same person.

### 2.1 Approaches considered

- **A — Explicit `identityId` field**, assigned at connect-time. Most correct: identity is a
  first-class concept, asked once, not inferred. Small migration (see §6).
- **B — Infer identity from mode-uniqueness** (at most one `subscription`, one `platform-credits`
  per identity; a second `subscription` add is automatically a new identity). No new field, but
  breaks down for `api-key` mode, where one identity can legitimately hold several keys, and is
  harder for a user to reason about ("why did this create a new group?").
- **C — Leave `CredentialAccount` untouched, group at the chain level** (`identityGroups:
  string[][]` on `CredentialChainState`). Avoids touching the account type, but pushes validation
  into every call site that reads or writes `chain`, and is a more contorted shape than A for the
  same result.

**Chosen: A.** It matches the real-world constraint directly (an OAuth login is the actual
boundary that matters, and only the user reliably knows whether two connections are "the same me"),
needs the smallest amount of new invariant-checking code, and the migration is trivial because
today's real accounts are one identity with up to three tiers.

### 2.2 The `identityId` model

- `identityId` groups credentials that belong to **one login**, at the granularity the provider's
  own CLI uses for a login (i.e. what `CLAUDE_CONFIG_DIR` / the Codex equivalent actually
  isolates) — not "one human," since one person can deliberately hold two logins.
- Connecting a **second `subscription`-mode credential** for a provider that already has one is the
  one case that structurally *cannot* be the same login (a single OAuth login cannot hold two
  subscriptions), so Fluent asks once, at connect-time: *"Is this a different account from
  `<existing label>`, or a billing tier on the same one?"* — and assigns a fresh `identityId` on
  "different," or the existing one on "same" (covers the rare case a provider ever supports linking
  a second subscription to one login).
- `platform-credits` and `api-key` connections default to the identity of the `subscription`
  credential already present for that provider (the common case — Console credits and a personal
  API key usually sit under the same login) but can be explicitly assigned to a different identity
  when the user says so.
- **`setChain` refuses to accept a chain whose accounts span more than one `identityId`.** This is
  the actual enforcement point: the automatic fallback machinery structurally cannot mix identities,
  regardless of what the UI later does or doesn't prevent.
- Two identities for one provider show as two separate credential groups on screen 10, each with its
  own chain/fallback policy. A lane picks one identity group when it's created — a single, visible,
  manual action (Principle 3), never something the broker later hops to on its own.

---

## 3. Race mode (R8, not yet built) — guardrail tightened

The research doc's R8 already says N should be drawn from "different providers/models/credentials."
This doc makes the identity boundary explicit before R8 is built: **the candidate pool for one race
must be either different providers, or different models/tiers within one identity — never two
identities of the same provider on the same task.** Per the decision made in brainstorming, this is
not a warn-and-allow UI: that combination is structurally never offered as a selectable pairing.

---

## 4. Non-goals added

- Not a credential pool or load-balancer that spreads one task across separate account identities to
  gain more combined throughput than either identity has on its own.
- Not ever extracting, storing, or re-sending a provider's OAuth/session token outside the CLI
  process it was issued to — no "fast path" that talks to a provider's API directly using a
  subscription token in place of spawning the real CLI.

---

## 5. Cross-reference: what this changes, by section of the main spec

| Main spec section | Change (this doc is the source of truth; the main spec file is not edited) |
|---|---|
| §2 Principles | Add Principle 7: *"Account identity is never something Fluent automates across. Automatic credential fallback only ever moves within one identity's own billing tiers; moving work to a different login is always a distinct, visible, user-initiated action."* |
| §7.5 Provider adapters | Add the token-boundary invariant (§1.3 above) |
| §9 Credential broker | Add the identity concept and the same-identity-only chain rule (§2 above) |
| §11 Coordination model | Note: creating a lane requires picking one identity per provider explicitly — a visible, manual step, not a default |
| §13 Non-goals | Add the two non-goals in §4 above |
| Research doc R8 | Tighten the candidate-pool rule per §3 above |

---

## 6. Data model change

```ts
export type CredentialAccount = {
  id: string;
  provider: ProviderId;
  mode: CredentialMode;
  label: string;
  identityId: string;   // NEW — groups credentials that belong to one login
  hasSecret?: boolean;
  baseUrl?: string;
};
```

- `upsertAccount` gains an `identityId` parameter; the connect flow derives or asks for it per §2.2.
- `setChain` validates every id in the proposed chain resolves to the same `identityId` as the
  others, and rejects (returns an error, not a silent partial-apply) if not.
- **Migration:** existing stored `CredentialChainState.accounts` (today's real state — one identity
  per provider) backfill a single freshly-generated `identityId`, applied to every existing account
  for that provider, on first load under the new schema.

## 7. Testing / verification

- Unit test: `setChain` rejects a chain mixing two `identityId`s.
- Unit test: adding a second `subscription`-mode account without an explicit "same account" answer
  defaults to a new `identityId`, never silently joins the existing chain.
- Migration test: pre-existing single-identity stored state backfills one `identityId` correctly and
  `setChain`/`reportUsageLimit` continue to work unchanged for that case.

---

## 8. Sources

- [Legal and compliance - Claude Code Docs](https://code.claude.com/docs/en/legal-and-compliance)
- [Updates to Consumer Terms and Privacy Policy — Anthropic](https://www.anthropic.com/news/updates-to-our-consumer-terms)
- [Anthropic clarifies ban on third-party tool access to Claude — The Register](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546)
- [Can I Use Multiple Accounts with Claude Code? — Usagebar](https://usagebar.com/blog/can-i-use-multiple-accounts-with-claude-code)
- [How to Run Multiple Claude Code Accounts (2026) — aq.dev](https://aq.dev/guides/run-multiple-claude-code-accounts/)
- [Can You Share an AI Subscription? Complete 2026 Guide — Krater](https://krater.ai/blog/share-ai-subscription-multiple-users)
