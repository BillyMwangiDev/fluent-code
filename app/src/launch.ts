// The launch sheet: one prompt, a count per provider, and a start button. It is the workspace's
// empty state, the `+ lanes` sheet, and the New Session page, so every path into a lane looks and
// behaves the same. Lanes start one after another: each Claude lane needs its own daemon-issued
// consent to write the project's hook settings, and a failure is reported against its lane.
import {api, permissionModeChoices, riskyPermissionModes, type CredentialChainState, type ProviderHealth, type ProviderId, type SessionSummary} from './api';
import {clampCount, defaultCounts, describePlan, launchPlan, maxLanesPerProvider, modelLinkedProviders, providerReadiness, type LaunchCounts, type ProviderReadiness} from './launch-plan';
import {prefs} from './prefs';
import {store} from './store';
import {navigate} from './router';
import {actionErrorText, askConfirm, button, directoryField, h, icon, openSheet, providerLabel, providerShort, segmented, showActionError, showNotice} from './ui';

export type LaunchMode = 'orchestrate' | 'parallel';

export type LaunchRequest = {
  mode: LaunchMode;
  directory: string;
  task: string;
  /** Parallel: lanes to start per provider. Orchestrate: the subagent pool the main agent may draw on. */
  counts: LaunchCounts;
  leadProvider: ProviderId;
  isolate: boolean;
  accountId?: Partial<Record<ProviderId, string>>;
  model: Partial<Record<'claude' | 'codex', string>>;
  permissionMode: Partial<Record<'claude' | 'codex', string>>;
};

export type LaunchProgress = {index: number; total: number; provider: ProviderId};
export type LaunchOutcome = {created: SessionSummary[]; failures: string[]};

export async function loadReadiness(): Promise<{readiness: ProviderReadiness[]; chains: CredentialChainState[]; providers: ProviderHealth[]}> {
  let [providers, chains] = await Promise.all([api.listProviders(), api.listCredentials().catch(() => [] as CredentialChainState[])]);
  // fluentd probes each CLI with `--version` under a short timeout. A slow first probe must not
  // leave the user looking at "not installed" for a CLI that is there, so an all-negative answer
  // is checked once more before it is believed.
  if (!providers.some(provider => provider.installed)) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    providers = await api.listProviders().catch(() => providers);
  }
  return {readiness: providerReadiness(providers, chains), chains, providers};
}

/** Creates every lane in the request, in order, reporting progress as each one starts. */
export async function runLaunch(request: LaunchRequest, readiness: readonly ProviderReadiness[], onProgress?: (progress: LaunchProgress) => void): Promise<LaunchOutcome> {
  const created: SessionSummary[] = [];
  const failures: string[] = [];
  const optionsFor = (provider: ProviderId) => provider === 'claude' || provider === 'codex'
    ? {model: request.model[provider]?.trim() || undefined, permissionMode: request.permissionMode[provider] || undefined}
    : {};
  if (request.mode === 'orchestrate') {
    onProgress?.({index: 0, total: 1, provider: request.leadProvider});
    try {
      const pool = poolFrom(request.counts, readiness);
      const lead = await api.createSession({
        provider: request.leadProvider,
        directory: request.directory,
        task: request.task.trim() || undefined,
        isolate: request.isolate,
        accountId: request.accountId?.[request.leadProvider],
        lead: {maxLanes: poolTotal(pool), pool},
        ...optionsFor(request.leadProvider)
      });
      created.push(lead);
      store.patch(lead);
    } catch (error) {
      failures.push(`${providerShort[request.leadProvider]}: ${actionErrorText(error)}`);
    }
    return {created, failures};
  }
  const plan = launchPlan(request.counts, readiness);
  for (const [index, provider] of plan.entries()) {
    onProgress?.({index, total: plan.length, provider});
    try {
      const session = await api.createSession({
        provider,
        directory: request.directory,
        task: request.task.trim() || undefined,
        isolate: request.isolate,
        accountId: request.accountId?.[provider],
        ...optionsFor(provider)
      });
      created.push(session);
      // The tile can appear now; the next poll would otherwise leave a gap of a few seconds.
      store.patch(session);
    } catch (error) {
      failures.push(`${providerShort[provider]}: ${actionErrorText(error)}`);
    }
  }
  return {created, failures};
}

/** The subagent pool a main agent gets: every ready provider the user gave a count. */
export function poolFrom(counts: LaunchCounts, readiness: readonly ProviderReadiness[]): Partial<Record<ProviderId, number>> {
  const pool: Partial<Record<ProviderId, number>> = {};
  for (const provider of readiness) {
    const count = clampCount(counts[provider.id]);
    if (provider.ready && count > 0) pool[provider.id] = count;
  }
  return pool;
}
export function poolTotal(pool: Partial<Record<ProviderId, number>>): number {
  return Object.values(pool).reduce((sum, count) => sum + (count ?? 0), 0);
}

/** Asks once before any lane starts without its CLI's own safety prompts. */
async function confirmRiskyModes(request: LaunchRequest): Promise<boolean> {
  const risky = (['claude', 'codex'] as const).filter(provider => {
    const mode = request.permissionMode[provider];
    const used = request.mode === 'orchestrate' ? request.leadProvider === provider : clampCount(request.counts[provider]) > 0;
    return used && mode && riskyPermissionModes[provider] === mode;
  });
  if (risky.length === 0) return true;
  return askConfirm({
    title: 'start without safety prompts',
    body: `${risky.map(provider => `${providerLabel[provider]} will run with “${request.permissionMode[provider]}”`).join(' and ')}, which removes its own prompts before it edits files or runs commands.`,
    confirmLabel: 'start anyway',
    danger: true
  });
}

type FormOptions = {
  directory: string;
  readiness: ProviderReadiness[];
  chains: CredentialChainState[];
  /** The page variant shows every option open; the sheet keeps advanced ones behind `more`. */
  variant: 'sheet' | 'page' | 'empty';
  initialMode?: LaunchMode;
  onLaunch: (request: LaunchRequest) => Promise<void> | void;
  onCancel?: () => void;
};

/** The launch form itself, without a container, so the workspace, the sheet, and the New Session
 * page can all mount it. */
export function launchForm(options: FormOptions): {el: HTMLElement; focus: () => void} {
  const {readiness} = options;
  const readyProviders = readiness.filter(provider => provider.ready);
  let mode: LaunchMode = options.initialMode ?? prefs.launchMode;
  const counts: LaunchCounts = defaultCounts(readiness, prefs.launchCounts);
  // The main agent needs a CLI Fluent can brief: Claude Code through its system-prompt flag, the
  // others ahead of their first prompt. Any ready provider qualifies; Claude is the usual pick.
  const remembered = readyProviders.find(provider => provider.id === prefs.leadProvider)?.id;
  let leadProvider: ProviderId = remembered ?? readyProviders.find(provider => provider.id === 'claude')?.id ?? readyProviders[0]?.id ?? 'claude';
  const accountId: Partial<Record<ProviderId, string>> = {};

  const task = h('textarea', {class: 'launch-task', rows: options.variant === 'sheet' ? '4' : '5', 'aria-label': 'Brief'}) as HTMLTextAreaElement;

  const modeControl = segmented<LaunchMode>([
    {id: 'orchestrate', label: 'main agent + subagents'},
    {id: 'parallel', label: 'same brief to every lane'}
  ], mode, next => { mode = next; syncMode(); });
  const modeHint = h('p', {class: 'muted launch-hint'});
  const poolLabel = h('div', {class: 'field-label pool-label'});

  // --- Parallel: a stepper per provider --------------------------------------------------------
  const stepperRows = readiness.map(provider => {
    const value = h('input', {type: 'number', class: 'stepper-value', min: '0', max: String(maxLanesPerProvider), inputmode: 'numeric', 'aria-label': `${provider.label} lanes`}) as HTMLInputElement;
    value.value = String(counts[provider.id] ?? 0);
    const set = (next: number) => {
      counts[provider.id] = clampCount(next);
      value.value = String(counts[provider.id]);
      syncSummary();
    };
    const minus = button(icon('minus'), () => set((counts[provider.id] ?? 0) - 1), {class: 'btn ghost icon-button', 'aria-label': `fewer ${provider.label} lanes`});
    const plus = button(icon('plus'), () => set((counts[provider.id] ?? 0) + 1), {class: 'btn ghost icon-button', 'aria-label': `more ${provider.label} lanes`});
    value.addEventListener('input', () => set(Number(value.value)));
    value.addEventListener('focus', () => value.select());
    const chain = options.chains.find(candidate => candidate.provider === provider.id);
    let detail: HTMLElement;
    if (!provider.ready) {
      const fix = button(provider.blocker === 'not installed' ? 'how to install' : 'connect an API key', () => {
        if (provider.blocker === 'not installed') {
          showNotice(`${provider.label} is not on fluentd's PATH. Install its CLI, then reopen this sheet.`);
        } else navigate({name: 'credentials'});
      }, {class: 'btn link'});
      detail = h('span', {class: 'stepper-detail muted'}, [provider.blocker ?? '', ' · ', fix]);
    } else if (chain && chain.accounts.length > 1) {
      const select = h('select', {class: 'stepper-account', 'aria-label': `${provider.label} account`}) as HTMLSelectElement;
      for (const account of chain.accounts) select.append(h('option', {value: account.id}, [account.label]));
      select.value = chain.activeAccountId ?? chain.accounts[0]!.id;
      accountId[provider.id] = select.value;
      select.addEventListener('change', () => { accountId[provider.id] = select.value; });
      detail = h('span', {class: 'stepper-detail muted'}, [select]);
    } else {
      detail = h('span', {class: 'stepper-detail muted'}, [[modelLinkedProviders.has(provider.id) ? 'via OpenCode' : undefined, provider.model, provider.accountLabel ?? (provider.version ? provider.version.trim().split(/\r?\n/)[0] : 'CLI login')].filter(Boolean).join(' · ')]);
    }
    const row = h('div', {class: `stepper-row${provider.ready ? '' : ' unavailable'}`}, [
      h('span', {class: `provider-dot ${provider.id}`}),
      h('span', {class: 'stepper-name'}, [providerLabel[provider.id]]),
      detail,
      h('span', {class: 'stepper'}, [minus, value, plus])
    ]);
    if (!provider.ready) { minus.disabled = true; plus.disabled = true; value.disabled = true; }
    return row;
  });
  const steppers = h('div', {class: 'stepper-list'}, stepperRows);

  // --- Orchestrate: the main agent, then the pool it may draw on (the steppers below) -------------
  const leadPicker = segmented(readyProviders.map(provider => ({id: provider.id, label: providerShort[provider.id]})), leadProvider, next => { leadProvider = next; prefs.leadProvider = next; syncSummary(); }, {'aria-label': 'Main agent'});
  const delegate = h('div', {class: 'delegate-block'}, [
    h('div', {class: 'field-row'}, [h('span', {class: 'field-label'}, ['main agent']), leadPicker, h('span', {class: 'muted'}, ['— you talk to it; it plans and directs the rest'])])
  ]);

  // --- Shared options -----------------------------------------------------------------------------
  const directory = h('input', {type: 'text', placeholder: '/path/to/project', value: options.directory, 'aria-label': 'Working directory'}) as HTMLInputElement;
  const isolate = h('input', {type: 'checkbox'}) as HTMLInputElement;
  isolate.checked = prefs.launchOptions.isolate ?? true;
  const modelInputs: Partial<Record<'claude' | 'codex', HTMLInputElement>> = {};
  const permissionSelects: Partial<Record<'claude' | 'codex', HTMLSelectElement>> = {};
  const advancedRows = (['claude', 'codex'] as const).filter(provider => readiness.find(entry => entry.id === provider)?.ready).map(provider => {
    const model = h('input', {type: 'text', placeholder: 'model — the CLI default when empty', 'aria-label': `${providerLabel[provider]} model`}) as HTMLInputElement;
    const permission = h('select', {'aria-label': `${providerLabel[provider]} permission mode`}) as HTMLSelectElement;
    permission.append(h('option', {value: ''}, [provider === 'codex' ? 'sandbox — the CLI default' : 'permission mode — the CLI default']));
    for (const choice of permissionModeChoices[provider] ?? []) permission.append(h('option', {value: choice}, [riskyPermissionModes[provider] === choice ? `${choice} — no safety prompts` : choice]));
    modelInputs[provider] = model;
    permissionSelects[provider] = permission;
    return h('div', {class: 'field-row advanced-row'}, [h('span', {class: 'field-label'}, [providerShort[provider]]), model, permission]);
  });
  const directoryRow = h('div', {class: options.variant === 'sheet' ? 'field-row' : 'launch-directory'}, [h('span', {class: 'field-label'}, ['directory']), directoryField(directory, path => { prefs.workspacePath = path; })]);
  const advanced = h('details', {class: 'launch-advanced'}, [
    h('summary', {}, ['more options']),
    options.variant === 'sheet' ? directoryRow : null,
    h('label', {class: 'check-label'}, [isolate, ' give each lane its own Git worktree ', h('span', {class: 'muted'}, ['— recommended for parallel agents; created beside the project'])]),
    ...advancedRows
  ]);
  if (options.variant === 'page') advanced.open = true;

  // --- Footer ---------------------------------------------------------------------------------------
  const summary = h('span', {class: 'launch-summary'});
  const start = h('button', {type: 'button', class: 'btn primary launch-start'}, ['start']);
  const status = h('p', {class: 'action-status', role: 'status'});
  const cancel = options.onCancel ? button('cancel', () => options.onCancel?.()) : null;

  function currentRequest(): LaunchRequest {
    return {
      mode,
      directory: directory.value.trim(),
      task: task.value,
      counts: {...counts},
      leadProvider,
      isolate: isolate.checked,
      accountId,
      model: {claude: modelInputs.claude?.value, codex: modelInputs.codex?.value},
      permissionMode: {claude: permissionSelects.claude?.value, codex: permissionSelects.codex?.value}
    };
  }

  function syncSummary() {
    if (mode === 'orchestrate') {
      const pool = poolFrom(counts, readiness);
      const total = poolTotal(pool);
      const shares = (Object.entries(pool) as Array<[ProviderId, number]>).map(([id, count]) => `${count} ${providerShort[id]}`).join(' · ');
      summary.textContent = total === 0 ? `main agent on ${providerShort[leadProvider]} · no subagents yet` : `main agent on ${providerShort[leadProvider]} · pool ${shares}`;
      start.textContent = 'start main agent';
      start.disabled = readyProviders.length === 0 || total === 0;
      return;
    }
    const plan = launchPlan(counts, readiness);
    summary.textContent = describePlan(plan, id => providerShort[id]);
    start.textContent = plan.length === 0 ? 'start' : plan.length === 1 ? 'start 1 lane' : `start ${plan.length} lanes`;
    start.disabled = plan.length === 0;
  }

  function syncMode() {
    delegate.hidden = mode !== 'orchestrate';
    poolLabel.hidden = mode !== 'orchestrate';
    poolLabel.textContent = 'subagent pool — how many of each the main agent may run at once';
    task.placeholder = mode === 'orchestrate'
      ? 'What should the main agent accomplish? It plans the work, starts subagents from the pool with their own prompts, reads what they report, and answers you.'
      : 'What should they work on? One brief, sent to every lane as its first prompt. Leave empty to start bare terminals.';
    modeHint.textContent = mode === 'orchestrate'
      ? 'You brief one agent. It splits the work, starts subagents from any model in the pool, reviews their output, and gives them feedback — the way a subagent ecosystem works.'
      : 'Every lane gets the same brief and works on its own. Good for independent tasks, or for racing several providers on one problem.';
    syncSummary();
  }

  start.addEventListener('click', async () => {
    const request = currentRequest();
    if (!request.directory) { directory.focus(); advanced.open = true; return; }
    if (!(await confirmRiskyModes(request))) return;
    start.disabled = true;
    status.className = 'action-status';
    status.textContent = 'starting…';
    prefs.launchCounts = Object.fromEntries(Object.entries(counts).filter(([, value]) => (value ?? 0) > 0));
    prefs.launchOptions = {isolate: isolate.checked};
    prefs.launchMode = mode;
    prefs.workspacePath = request.directory;
    try {
      await options.onLaunch(request);
    } catch (error) {
      status.className = 'action-status error';
      status.textContent = actionErrorText(error);
      showActionError(error);
    } finally {
      syncSummary();
    }
  });
  task.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); start.click(); }
  });

  if (readyProviders.length === 0) {
    modeHint.textContent = 'No provider can start a lane yet. Install Claude Code or Codex, or connect an API key for an OpenCode provider.';
  }

  const el = h('div', {class: `launch-form launch-${options.variant}`}, [
    options.variant === 'sheet' ? null : directoryRow,
    h('div', {class: 'launch-mode'}, [modeControl, modeHint]),
    delegate,
    task,
    poolLabel,
    steppers,
    advanced,
    h('div', {class: 'launch-foot'}, [summary, status, h('div', {class: 'actions'}, [cancel, start])])
  ]);
  syncMode();
  return {el, focus: () => task.focus()};
}

/** Opens the launch sheet over the current page. Resolves when it closes. `onLaunched` runs after
 * the lanes were created, with the sheet already closed so the caller can show them. */
export async function openLaunchSheet(options: {directory: string; initialMode?: LaunchMode; onLaunched?: (outcome: LaunchOutcome) => void; onProgress?: (progress: LaunchProgress) => void}) {
  const {readiness, chains} = await loadReadiness();
  let sheet: {close: () => void} | undefined;
  const form = launchForm({
    directory: options.directory,
    readiness,
    chains,
    variant: 'sheet',
    initialMode: options.initialMode,
    onCancel: () => sheet?.close(),
    onLaunch: async request => {
      sheet?.close();
      const outcome = await runLaunch(request, readiness, options.onProgress);
      if (outcome.failures.length) showActionError(new Error(`${outcome.failures.length} lane${outcome.failures.length === 1 ? '' : 's'} did not start — ${outcome.failures[0]}`));
      options.onLaunched?.(outcome);
    }
  });
  sheet = openSheet({title: 'start agents', subtitle: 'every agent is the real CLI in its own terminal, on the account that CLI would use', body: form.el});
  form.focus();
}
