# Token Economics for a Local Multi-Agent Orchestrator (Fluent Code) — Sept 2026

## 1. Does orchestration increase or reduce token usage vs. one agent, one terminal?

**It increases raw spend per unit of work, almost always. The real question is $/completed-task, not $/session.**

**Increases (measured):**
- **Context duplication.** Each lane is a separate process with its own system prompt + serialized tool/MCP schemas — nothing shared. A single Claude Code subagent costs **~436K tokens before reading one file** ([dev.to measurement](https://dev.to/rulestack/a-claude-code-subagent-costs-436k-tokens-before-it-reads-a-single-file-measured-with-the-1ja9)).
- **Subagent/fan-out multiplier.** Anthropic's own multi-agent research post: subagent runs use **~4x** the tokens of chat; full orchestrator+parallel-worker runs use **~15x**, with token volume explaining ~80% of eval performance variance ([via Simon Willison](https://simonwillison.net/2025/Jun/14/multi-agent-research-system/)). Claude Code's docs put **Agent Teams at ~7x** standard-session tokens in plan mode ([code.claude.com/docs/en/costs](https://code.claude.com/docs/en/costs)).
- **Merge conflicts.** A 107K+-PR study of AI-agent-authored code found a **27.67% textual merge-conflict rate** (29K+ conflicting PRs) ([AgenticFlict, arXiv:2604.03551](https://arxiv.org/abs/2604.03551)) — each conflict costs a re-invoked resolution turn with zero net progress.
- **Context loss / re-reads after compaction.** Across 287,748 traced API calls, sessions re-ingest context above steady-state for **~28 steps post-compaction**; one session **re-read a 610KB file 53 times** ([LangWatch](https://langwatch.ai/blog/context-tax-when-to-compact)).
- **Coordination text** (task board, file claims, cross-lane messages) adds tokens to every lane's every turn — real, unmeasured in public literature, scales with lane count.
- **Runaway loops are the fat tail.** Four unmonitored LangChain agents ping-ponged for **11 days, $47,000** ([API Lens](https://www.apilens.tech/blog/ai-agent-infinite-loop-billing-disaster)) — the risk an unattended-lane orchestrator is directly exposed to.

**Reductions (measured):**
- **Prompt-cache continuity.** Cache reads cost **10%** of base input (2.5% on Fable-tier) vs. 1.25x/2x for 5-min/1-hour writes ([Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Real Claude Code sessions report **91% of input tokens served from cache** ([code.claude.com/docs/en/costs](https://code.claude.com/docs/en/costs)) — keeping a lane alive is the single biggest lever available.
- **Smaller, scoped tasks avoid broad-scan tax.** Anthropic: vague prompts trigger wide exploration; specific prompts (the natural shape of one lane = one task) minimize file reads.
- **Avoiding restarts preserves the 1-hour cache TTL** on subscriptions (vs. 5 min on API keys) — a lost window forces a full cache-miss re-read.
- **Model right-sizing.** A published 3-tier routing model (Opus/Sonnet/Haiku by role) reports **51% savings** vs. uniform Opus ([MindStudio](https://www.mindstudio.ai/blog/ai-model-routing-fable-5-opus-sonnet-haiku)).
- **Killing runaway lanes** caps the tail risk above; no measured "average" saving exists, but the $47K counterfactual sets a very high ceiling on this lever.

**Net:** single-terminal is cheaper for one task done once. Orchestration pays off only when parallel wall-clock value is real, tasks decompose without file contention, and the failure modes above are actively suppressed.

## 2. 2026 pricing and cache mechanics that matter

- **Claude API (first-party, Sept 2026):** Sonnet 5 $2/$10 per MTok, Opus 5 $5/$25, Haiku 4.5 $1/$5, Fable 5.1 $10/$50.
- **Cache pricing:** 5-min writes 1.25x, 1-hour writes 2x, reads 0.1x (0.025x Fable/Mythos-tier) ([Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
- **Default TTL 5 minutes**, extendable to 1 hour. Claude Code specifically runs **1-hour TTL on subscription, dropping to 5 min once on usage credits or an API key** ([code.claude.com/docs/en/costs](https://code.claude.com/docs/en/costs)).
- **Invalidation:** any prefix byte change breaks the cache. Order is `tools → system → messages`; a changed tool list invalidates everything downstream. Verify via `usage.cache_read_input_tokens` — zero on repeat calls means a silent invalidator (timestamps, unsorted JSON, varying tool set) ([Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
- **Credential/endpoint switching** matters directly for Fluent: subscription→API-key fallback on rate-limit both drops TTL 1h→5m and re-prices the fallback turn at API rates.
- **Claude Max/Pro:** usage is one pool shared across Claude chat, Code, and Cowork, on a **rolling 5-hour window from first prompt** plus a separate weekly cap; Pro ~10-45 prompts/window, Max 20x up to ~900 ([TokenKarma](https://tokenkarma.app/blog/anthropic-usage-limits-explained-2026/)). Official enterprise data: **avg $13/dev/active-day, $150-250/month**, <$30/day for 90% of users ([code.claude.com/docs/en/costs](https://code.claude.com/docs/en/costs)).
- **API tiers** (Start/Build/Scale/Custom) gate RPM/ITPM/OTPM and spend caps ($500/$1,000/$200,000); **cached reads generally don't count against ITPM** ([requesty.ai](https://www.requesty.ai/blog/rate-limits-for-llm-providers-openai-anthropic-and-deepseek)).
- **OpenAI/Codex:** cached input 90% off list. Default retention moved to **24h** (May 2026) for GPT-5.5-class; GPT-5.6 (July 2026) replaced free implicit caching with explicit breakpoints and a **30-min minimum TTL** ([Effloow](https://effloow.com/articles/openai-prompt-cache-retention-24h-cost-proof-2026)). Codex on ChatGPT is metered separately from API, **rolling 5h window + weekly cap**; OpenAI restored the 5h Plus limit Aug 2026 after briefly removing it, while both Pro tiers keep it off "for the upcoming months" ([9to5Mac](https://9to5mac.com/2026/08/24/openai-restores-5-hour-codex-and-work-limits-for-chatgpt-plus-users/)).

## 3. What developers use today, and the gaps

- **ccusage** ([github.com/ryoppippi/ccusage](https://github.com/ryoppippi/ccusage)) parses local JSONL logs into daily/weekly/5h-block reports, no account needed. **Gaps:** pull-based, not live ("won't tell you you're on pace to hit the limit in 40 minutes"); LiteLLM-estimated pricing drifts $1-2/session from invoices; sees only what's locally logged ([dev.to](https://dev.to/agenticstack/architectural-breakdown-i-wrote-a-tool-to-find-blind-spots-it-had-one-1kcp)).
- **claude-code-usage-monitor forks** — real-time burn-rate dashboards, same local-only blind spot.
- **Claude Code's `/usage`** — session cost, a cache hit-rate line (91% example, with named miss causes like "tool definitions changed"), per-skill/subagent/MCP attribution, behavior flags ≥10% of usage. Most complete first-party view, but **doesn't cover subagents' own token use** in the cache line, and is single-machine ([code.claude.com/docs/en/costs](https://code.claude.com/docs/en/costs)).
- **Codex CLI `/status` `/usage`** — 5h/weekly/credits breakdown, separate from API billing.
- **Anthropic Console** — workspace hard spend caps (429 on hit), org/workspace budgets, 50/75/90% alerts, cost dashboard by workspace/model/token-type, Admin API pull ([Torii](https://www.toriihq.com/articles/seven-tools-to-manage-anthropic-api-spend)). **Gap:** none of this exists for subscription usage — invisible to Console entirely.
- **OpenRouter** — per-key/model/app spend, configurable-reset credit caps ([OpenRouter blog](https://openrouter.ai/blog/tutorials/team-spend-controls-setup/)). Strong for multi-provider routing; not applicable to Fluent (no proxy).
- **Universal gap:** nothing attributes spend to *task outcome*. Tools report tokens/$ consumed, not $-per-shipped-change, and none separate productive tokens from rework/loop/conflict tokens — the legibility problem an orchestrator with task-board context is uniquely positioned to solve.

## 4. Levers for Fluent Code

- **Per-lane budget + auto-stop** targets the largest measured tail risk directly ($47K/11-day case); cheap since Fluent already parses transcripts.
- **Cache-aware scheduling** (pin credential/model per lane, batch turns inside TTL, avoid mid-task provider fallback except on real rate-limit) protects the 91%-cache-hit regime — losing it is a ~10x input-cost multiplier on that lane's next turn.
- **Idle vs. stuck-loop detection are different problems.** Idle waiting on human input burns ~$0.04/session in background tasks ([code.claude.com/docs/en/costs](https://code.claude.com/docs/en/costs)); a stuck reasoning loop burns full-rate tokens every turn with no output. Fluent's coordination CLI (no new claims, no task-board writes, repeated identical tool calls) gives a cheap signal a raw process monitor can't.
- **Model routing hints** ride the measured 51% three-tier saving directly.
- **Rate-limit-aware pacing** matters because the 5-hour window is shared across all lanes on one subscription — a low-value lane can exhaust a window a high-value lane needed.

## 5. What users need to see to believe it saved money

- **Per-lane, per-task $ figures**, not just session totals — extend Claude Code's own per-skill/subagent attribution pattern to per-lane, per-task-board-item.
- **A counterfactual baseline**: "serial in one terminal at Opus: ~$X; actual across N lanes: $Y" — without this, parallel spend always *looks* worse even when $/shipped-task is better.
- **Cache hit-rate with miss cause**, copying Claude Code's already-proven UI pattern ("2 misses, likely cause: tool definitions changed").
- **Runaway/loop flags with the delta prevented** — "stopped after N turns with no board progress, saved ~$Z at current burn rate" so auto-stop reads as savings, not a false-positive interruption.
- **A rolling $/window view against the shared 5-hour and weekly caps** — the resource users actually feel constrained by, not raw dollars.
- **A distinct rework bucket**: tokens spent on merge-conflict resolution, post-compaction re-reads, and restarted lanes, shown separately as the number a well-run orchestrator should visibly drive toward zero.

## Levers ranked by expected impact

| Lever | Expected impact | Evidence strength | Implementation cost |
|---|---|---|---|
| Per-lane budget + auto-stop on runaway/loop | High — caps tail risk ($47K/11-day case shows unbounded downside) | Strong (documented incident; "hard budget before each call" is the standard fix) | S |
| Cache-aware scheduling (stable credential/model, batch within TTL) | High — cache reads ~10x cheaper; real sessions hit 91% cache-served | Strong (official Anthropic docs + Claude Code `/usage` data) | M |
| Model routing hints (Haiku/Sonnet grunt lanes, Opus/Fable coordination) | High — ~51% reported saving, 3-tier routing | Moderate (one vendor's model, consistent with Anthropic's own subagent guidance) | M |
| Idle-lane vs. stuck-loop detection | Medium-High — idle ~$0.04/session; stuck loops cost full-rate tokens indefinitely | Moderate (idle figure official; loop-cost is case-study, not benchmarked) | M |
| Rate-limit-aware pacing across shared 5h/weekly window | Medium — protects high-value lanes from low-value lanes exhausting a shared cap | Moderate (mechanics documented; no public $ figure) | M |
| $/task legibility (per-lane, per-task, cache-miss cause) | Medium — behavior-change lever, not a direct token saving | Strong (Claude Code's `/usage` proves the UI pattern works) | M |
| Compaction timing tuned to workload | Medium — over/under-compaction both waste tokens; sweet spot ~250-450k tokens | Moderate (single large measurement study, not vendor-official) | M/L |
| Limiting subagent fan-out/depth | Medium — subagents ~4x chat, multi-agent ~15x, Agent Teams ~7x | Strong (Anthropic's own post + Claude Code docs) | S |
| Dedup of shared context across lanes | Low-Medium — no direct measurement for this pattern; inferred from cache economics | Weak (reasoned, not directly measured) | L |
| Merge-conflict-aware scheduling (avoid parallel writes to hotspot files) | Low-Medium — 27.67% conflict rate on agent PRs; each conflict costs a rework turn | Strong (142K-PR study) | M |

---

**Sources:** linked inline; primary ones are Anthropic's prompt-caching and Claude Code cost docs, Anthropic's multi-agent research post, the AgenticFlict merge-conflict study (arXiv:2604.03551), and LangWatch's 287K-call compaction study.
