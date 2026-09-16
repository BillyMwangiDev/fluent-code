// --- Spend -------------------------------------------------------------------
// --- Spend ---------------------------------------------------------------------
// Layout adapted from T3 Code's Usage page (apps/web/src/components/usage/UsagePage.tsx,
// MIT licensed) — the same visual shape (provider breakdown + daily chart, totals row, a
// model/day breakdown table, price overrides) redrawn as vanilla TS/CSS. Distinct from the
// 'usage' screen above (which is live, per-session status-line telemetry): this is cross-session
// historical cost, scanned from the providers' own transcript files, same as T3's approach.
import {api} from '../api';
import {store} from '../store';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {h, markEl, button, askConfirm, showActionError, showNotice, actionErrorText, relativeTime, formatTokens, formatUsd, formatPercent, bytes, duration, providerLabel, providerColor, modelLinkDefaults, accountLabel, verificationPill, laneReady, quotaLabel, directoryField, pickDirectory, workspaceFolderName, segmented, isLive, sessionName} from '../ui';
import {metricCard, sparklineChart, lineChart} from '../charts';
import {windowLabel, windowLevel, laneCostText, windowsByProvider} from '../limits';

import type {CredentialChainState, PriceOverride, ProviderId, SpendModelBucket} from '../api';

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {month: 'short', day: 'numeric', timeZone: 'UTC'});
}

function sumTokenTotals(a: {uncachedInputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number}): number {
  return a.uncachedInputTokens + a.cachedInputTokens + a.cacheCreationTokens + a.outputTokens;
}

export async function renderSpend(main: HTMLElement) {
  let rangeDays = 30;
  let breakdown: 'model' | 'day' = 'model';
  const container = h('div', {});
  main.append(container);

  async function draw() {
    container.innerHTML = '';
    // Scanning transcript files (spec-worthy amount of real data — see spend-tracker.ts) is not
    // instant; without this, the screen just looks broken for a few seconds on every visit.
    container.append(h('div', {class: 'empty-state'}, ['scanning provider transcripts…']));
    let summary;
    let chains: CredentialChainState[] = [];
    try {
      [summary, chains] = await Promise.all([api.spendSummary(rangeDays), api.listCredentials().catch(() => [])]);
    } catch (error) {
      container.innerHTML = '';
      container.append(h('div', {class: 'empty-state'}, [error instanceof Error ? error.message : String(error)]));
      return;
    }
    // store.sessions/store.usage back the by-lane table below — fluentd already polls them for
    // the rail and workspace, so this avoids a second sessions.list/usage.snapshot round trip.
    if (!store.loaded) await store.refresh();
    if (store.usage.size === 0) await store.refreshUsage();
    container.innerHTML = '';

    const rangeButtons = h('div', {class: 'segmented'});
    for (const days of [7, 30, 90]) {
      const button = h('button', {class: `btn${days === rangeDays ? ' primary' : ''}`}, [`${days}d`]);
      button.addEventListener('click', () => {
        rangeDays = days;
        void draw();
      });
      rangeButtons.append(button);
    }
    container.append(
      h('div', {class: 'toolbar'}, [
        h('div', {}, [
          h('h1', {class: 'section-title'}, [markEl(), 'spend']),
          h('p', {class: 'section-sub'}, ["cross-session token cost, scanned from each provider's own transcripts — an API-equivalent estimate, not your subscription bill"])
        ]),
        rangeButtons
      ])
    );

    if (summary.ratesError) {
      container.append(h('div', {class: 'banner advisory'}, [h('strong', {}, ['pricing table stale — ']), h('span', {}, [summary.ratesError])]));
    }

    // Limits — one row per provider that has reported a usage window, merged with the active
    // account's label so it reads like the workspace strip's chips, just larger.
    const limitsCard = h('div', {class: 'card'}, [h('h3', {}, ['limits'])]);
    const windows = windowsByProvider([...store.usage.values()]);
    if (windows.size === 0) {
      limitsCard.append(h('p', {class: 'section-sub'}, ["no limit windows reported yet — they appear after a lane's first turn"]));
    } else {
      for (const providerId of [...windows.keys()].sort()) {
        const provider = providerId as ProviderId;
        const window = windows.get(providerId)!;
        const account = accountLabel(chains.find(chain => chain.provider === provider)?.activeAccountId, chains);
        const primaryText = windowLabel(window.primary);
        const secondaryText = windowLabel(window.secondary);
        const level = windowLevel(window.primary) ?? windowLevel(window.secondary);
        limitsCard.append(
          h('div', {class: 'provider-row'}, [
            h('div', {class: 'row-top'}, [
              h('span', {class: 'row-label'}, [h('span', {class: `provider-dot ${provider}`}), h('span', {class: 'name'}, [`${providerLabel[provider]} · ${account}`])]),
              (primaryText ?? secondaryText) ? h('span', {class: `row-value${level && level !== 'ok' ? ' warn' : ''}`}, [primaryText ?? secondaryText!]) : null
            ]),
            primaryText && secondaryText ? h('span', {class: 'row-sub'}, [secondaryText]) : null
          ])
        );
      }
    }
    container.append(limitsCard);

    // Per-provider aggregation across the whole range, for the left-column breakdown rows.
    const byProvider = new Map<ProviderId, {costUsd: number; tokens: number}>();
    for (const day of summary.days) {
      for (const model of day.models) {
        const entry = byProvider.get(model.provider) ?? {costUsd: 0, tokens: 0};
        entry.costUsd += model.costUsd;
        entry.tokens += sumTokenTotals(model.totals);
        byProvider.set(model.provider, entry);
      }
    }
    const activeProviders = [...byProvider.keys()].sort();

    const left = h('div', {}, [
      h('div', {class: 'spend-total'}, [formatUsd(summary.totalCostUsd)]),
      h('p', {class: 'spend-total-sub'}, [`${summary.rangeDays} days · ${formatTokens(sumTokenTotals(summary.totals))} tokens processed`])
    ]);
    if (activeProviders.length === 0) {
      left.append(h('p', {class: 'section-sub'}, ['No usage recorded in this window yet — run a session and check back.']));
    }
    for (const provider of activeProviders) {
      const totals = byProvider.get(provider)!;
      const share = summary.totalCostUsd > 0 ? totals.costUsd / summary.totalCostUsd : 0;
      left.append(
        h('div', {class: 'provider-row'}, [
          h('div', {class: 'row-top'}, [
            h('span', {class: 'row-label'}, [h('span', {class: `provider-dot ${provider}`}), h('span', {class: 'name'}, [providerLabel[provider]])]),
            h('span', {class: 'row-value'}, [formatUsd(totals.costUsd)])
          ]),
          h('span', {class: 'row-sub'}, [`${formatPercent(share)} of cost · ${formatTokens(totals.tokens)} tokens`])
        ])
      );
    }

    // Daily cost as a per-provider line chart — the same shape as T3's own usage chart
    // (apps/web/src/components/usage/UsageProviderChart.tsx) and the Usage Observatory artboard.
    const chartColumn = h('div', {});
    chartColumn.append(h('h2', {class: 'section-title'}, ['daily cost']));
    const dailySeries = activeProviders.map(provider => ({
      label: providerLabel[provider],
      color: providerColor[provider],
      values: summary.days.map(day => day.models.filter(model => model.provider === provider).reduce((sum, model) => sum + model.costUsd, 0))
    }));
    chartColumn.append(lineChart(summary.days.map(day => dayLabel(day.day)), dailySeries, formatUsd));

    container.append(h('div', {class: 'spend-grid'}, [left, chartColumn]));

    container.append(
      h('div', {class: 'card'}, [
        h('h3', {}, ['totals']),
        h('div', {class: 'metrics-grid'}, [
          metricCard('processed tokens', formatTokens(sumTokenTotals(summary.totals)), ''),
          metricCard('cached input', formatTokens(summary.totals.cachedInputTokens), ''),
          metricCard('uncached input', formatTokens(summary.totals.uncachedInputTokens), ''),
          metricCard('output', formatTokens(summary.totals.outputTokens), ''),
          metricCard('cache savings', formatUsd(summary.totalCacheSavingsUsd), '')
        ])
      ])
    );

    // By lane — joins the live session list and its usage telemetry, last 30 days, not archived.
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const laneRows = store.sessions
      .filter(session => !session.archivedAt && Date.now() - new Date(session.createdAt).getTime() <= thirtyDaysMs)
      .map(session => ({session, usage: store.usage.get(session.id)}))
      .sort((a, b) => (b.usage?.costUsd ?? -1) - (a.usage?.costUsd ?? -1));
    const laneCard = h('div', {class: 'card'}, [h('h3', {}, ['by lane'])]);
    if (laneRows.length === 0) {
      laneCard.append(h('p', {class: 'section-sub'}, ['no lane usage yet']));
    } else {
      const laneTable = h('table', {class: 'spend'});
      laneTable.append(h('thead', {}, [h('tr', {}, ['lane', 'provider · model', 'cost', 'tokens', 'cache', 'status', 'started'].map(label => h('th', {}, [label])))]));
      const tbody = h('tbody');
      for (const {session, usage} of laneRows) {
        const tokens = usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined) ? formatTokens((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) : '—';
        const cache = usage?.cacheHitRatio === undefined ? '—' : `${(usage.cacheHitRatio * 100).toFixed(0)}%`;
        tbody.append(
          h('tr', {}, [
            h('td', {}, [sessionName(session)]),
            h('td', {}, [session.model ? `${providerLabel[session.provider]} · ${session.model}` : providerLabel[session.provider]]),
            h('td', {class: 'num'}, [laneCostText(usage) ?? '—']),
            h('td', {class: 'num'}, [tokens]),
            h('td', {class: 'num'}, [cache]),
            h('td', {}, [h('span', {class: `pill status-${session.status}`}, [session.status])]),
            h('td', {}, [relativeTime(session.createdAt)])
          ])
        );
      }
      laneTable.append(tbody);
      laneCard.append(laneTable);
    }
    container.append(laneCard);

    // Fallbacks — every credential.switched event fluentd logged for this range, so the broker's
    // value (kept a lane running past a limit) is visible, not just its cost.
    const events = summary.credentialEvents ?? [];
    const fallbacksCard = h('div', {class: 'card'}, [
      h('h3', {}, [events.length ? `${events.length} fallback${events.length === 1 ? '' : 's'} kept lanes running in the last ${summary.rangeDays}d` : 'fallbacks'])
    ]);
    if (events.length === 0) {
      fallbacksCard.append(h('p', {class: 'section-sub'}, ['no credential switches in this range']));
    } else {
      for (const event of [...events].sort((a, b) => b.at.localeCompare(a.at))) {
        const resetSuffix = event.resetAt ? ` (resets ${new Date(event.resetAt).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})})` : '';
        fallbacksCard.append(h('p', {class: 'section-sub'}, [`${providerLabel[event.provider]} · ${accountLabel(event.fromAccountId, chains)} → ${accountLabel(event.toAccountId, chains)} · ${event.reason} · ${relativeTime(event.at)}${resetSuffix}`]));
      }
    }
    container.append(fallbacksCard);

    // Breakdown — Model (all days combined) or Day, matching T3's toggle.
    const breakdownToggle = h('div', {class: 'segmented'});
    for (const option of ['model', 'day'] as const) {
      const button = h('button', {class: `btn${breakdown === option ? ' primary' : ''}`}, [option]);
      button.addEventListener('click', () => {
        breakdown = option;
        void draw();
      });
      breakdownToggle.append(button);
    }

    const table = h('table', {class: 'spend'});
    if (breakdown === 'model') {
      const byModel = new Map<string, SpendModelBucket>();
      for (const day of summary.days) {
        for (const model of day.models) {
          const key = `${model.provider}::${model.model}`;
          const existing = byModel.get(key);
          if (existing) {
            existing.costUsd += model.costUsd;
            existing.cacheSavingsUsd += model.cacheSavingsUsd;
            existing.totals = {
              uncachedInputTokens: existing.totals.uncachedInputTokens + model.totals.uncachedInputTokens,
              cachedInputTokens: existing.totals.cachedInputTokens + model.totals.cachedInputTokens,
              cacheCreationTokens: existing.totals.cacheCreationTokens + model.totals.cacheCreationTokens,
              outputTokens: existing.totals.outputTokens + model.totals.outputTokens,
              reasoningTokens: existing.totals.reasoningTokens + model.totals.reasoningTokens
            };
          } else {
            byModel.set(key, {...model});
          }
        }
      }
      table.append(h('thead', {}, [h('tr', {}, ['model', 'tokens', 'cost', 'source'].map(label => h('th', {}, [label])))]));
      const tbody = h('tbody');
      for (const bucket of [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd)) {
        tbody.append(
          h('tr', {}, [
            h('td', {}, [`${providerLabel[bucket.provider]} · ${bucket.model}`]),
            h('td', {class: 'num'}, [formatTokens(sumTokenTotals(bucket.totals))]),
            h('td', {class: 'num'}, [formatUsd(bucket.costUsd)]),
            h('td', {class: 'num'}, [h('span', {class: 'cost-source'}, [bucket.costSource])])
          ])
        );
      }
      table.append(tbody);
    } else {
      table.append(h('thead', {}, [h('tr', {}, ['day', 'tokens', 'cost'].map(label => h('th', {}, [label])))]));
      const tbody = h('tbody');
      for (const day of [...summary.days].reverse()) {
        tbody.append(h('tr', {}, [h('td', {}, [day.day]), h('td', {class: 'num'}, [formatTokens(sumTokenTotals(day.totals))]), h('td', {class: 'num'}, [formatUsd(day.costUsd)])]));
      }
      table.append(tbody);
    }

    container.append(
      h('div', {class: 'card'}, [h('div', {class: 'toolbar'}, [h('h3', {}, ['breakdown']), breakdownToggle]), table])
    );

    // Price overrides.
    const overridesCard = h('div', {class: 'card'}, [h('h3', {}, ['price overrides']), h('p', {class: 'section-sub'}, [summary.ratesUpdatedAt ? `LiteLLM rates updated ${relativeTime(summary.ratesUpdatedAt)}` : 'LiteLLM rates not yet fetched'])]);
    const overrideEntries = Object.entries(summary.priceOverrides);
    if (overrideEntries.length === 0) {
      overridesCard.append(h('p', {class: 'section-sub'}, ['No overrides set — unpriced or wrong-priced models fall back to the LiteLLM public rate table.']));
    }
    for (const [model, override] of overrideEntries) {
      const row = h('div', {class: 'override-row'}, [
        h('span', {}, [model, ' — ', `$${override.inputCostPerMillionTokens}/M in · $${override.outputCostPerMillionTokens}/M out`]),
        h('button', {class: 'btn'}, ['remove'])
      ]);
      row.querySelector('button')!.addEventListener('click', async () => {
        await api.clearPriceOverride(model);
        void draw();
      });
      overridesCard.append(row);
    }
    const modelInput = h('input', {type: 'text', placeholder: 'model id (e.g. claude-sonnet-5)'});
    const inputRateInput = h('input', {type: 'number', placeholder: '$/M input tokens', step: '0.01'});
    const outputRateInput = h('input', {type: 'number', placeholder: '$/M output tokens', step: '0.01'});
    const saveButton = h('button', {class: 'btn primary'}, ['save']);
    saveButton.addEventListener('click', async () => {
      const model = modelInput.value.trim();
      const inputRate = Number(inputRateInput.value);
      const outputRate = Number(outputRateInput.value);
      if (!model || !Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return;
      const override: PriceOverride = {inputCostPerMillionTokens: inputRate, outputCostPerMillionTokens: outputRate};
      await api.setPriceOverride(model, override);
      void draw();
    });
    overridesCard.append(h('div', {class: 'override-form'}, [modelInput, inputRateInput, outputRateInput, saveButton]));
    container.append(overridesCard);
  }

  await draw();
}
