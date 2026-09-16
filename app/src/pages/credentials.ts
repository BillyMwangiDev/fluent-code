// --- Credentials ------------------------------------------------------------
import {api} from '../api';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {h, markEl, button, askConfirm, showActionError, showNotice, actionErrorText, relativeTime, formatTokens, formatUsd, formatPercent, bytes, duration, providerLabel, providerColor, modelLinkDefaults, accountLabel, verificationPill, laneReady, quotaLabel, directoryField, pickDirectory, workspaceFolderName, segmented, isLive} from '../ui';
import {metricCard, sparklineChart, lineChart} from '../charts';

import type {CredentialChainState, CredentialMode, ProviderId} from '../api';

let credentialProvider: ProviderId = 'claude';

function replaceMain(main: HTMLElement): HTMLElement {
  main.innerHTML = '';
  return main;
}

export async function renderCredentials(main: HTMLElement) {
  const providerLabels = providerLabel;
  main.append(
    h('h1', {class: 'section-title'}, [markEl(), `${providerLabels[credentialProvider]} credentials`]),
    h('p', {class: 'section-sub'}, ['fluent uses these in order — the highest connected credential runs your sessions'])
  );

  const providers = h('div', {class: 'segmented'});
  (Object.keys(providerLabels) as ProviderId[]).forEach(provider => {
    const button = h('button', {class: `btn${credentialProvider === provider ? ' primary' : ''}`}, [providerLabels[provider]]);
    button.addEventListener('click', () => { credentialProvider = provider; void refresh(); });
    providers.append(button);
  });
  main.append(providers);

  const chain = (await api.listCredentials()).find(c => c.provider === credentialProvider) ?? {
    provider: credentialProvider,
    accounts: [],
    chain: [],
    fallbackPolicy: 'always-ask' as const
  };

  // Connection state comes from the provider CLI's own `auth status`, never from its credential
  // files (spec §7.5) — so this says "connected" without Fluent ever holding an OAuth token.
  const authByAccount = credentialProvider === 'claude'
    ? Object.fromEntries((await api.authStatus().catch(() => [])).map(status => [status.accountId, status]))
    : {};

  const list = h('div', {});
  main.append(list);

  const removeButton = (account: CredentialChainState['accounts'][number]) => {
    const button = h('button', {class: 'btn danger', type: 'button'}, ['remove']);
    button.addEventListener('click', async () => {
      const detail = account.mode === 'api-key'
        ? 'Its stored key is deleted from the system keychain.'
        : 'Fluent’s separate sign-in profile for it is deleted, so you would sign in again if you add it back.';
      if (!(await askConfirm({title: `remove ${account.label}`, body: `Remove this ${providerLabels[credentialProvider]} account from Fluent? ${detail} Past sessions keep their record.`, confirmLabel: 'remove account', danger: true}))) return;
      button.disabled = true;
      try {
        await api.removeAccount(credentialProvider, account.id);
        void refresh();
      } catch (error) {
        showActionError(error);
        button.disabled = false;
      }
    });
    return button;
  };

  function renderList() {
    list.innerHTML = '';
    chain.chain.forEach((accountId, index) => {
      const account = chain.accounts.find(a => a.id === accountId);
      if (!account) return;
      const isActive = chain.activeAccountId === accountId;
      const auth = authByAccount[accountId];
      const connection = auth
        ? (auth.loggedIn ? `connected${auth.authMethod ? ` · ${auth.authMethod}` : ''}` : 'not connected')
        : '';
      const row = h('div', {class: `option-row${isActive ? ' selected' : ''}`}, [
        h('span', {class: 'label'}, [`${index + 1}. ${account.label}`]),
        h('span', {class: auth && !auth.loggedIn ? 'error' : 'meta'}, [[account.mode, account.model ? `model ${account.model}` : '', connection, isActive ? 'active now' : ''].filter(Boolean).join(' · ')])
      ]);
      // Every row has at least one control now (remove), so they sit in one right-aligned group.
      const controls = h('div', {class: 'actions'});
      if (index > 0) {
        const up = h('button', {class: 'btn'}, ['↑']);
        up.addEventListener('click', async () => {
          const reordered = [...chain.chain];
          [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
          await api.setChain(credentialProvider, reordered);
          chain.chain = reordered;
          renderList();
        });
        controls.append(up);
      }
      controls.append(removeButton(account));
      row.append(controls);
      list.append(row);
      // Subscription and Console credits are both OAuth logins the CLI owns, so Fluent shows the
      // command rather than running it: the browser flow is the user's business with Anthropic
      // (spec §9), and each account keeps its own config directory so both can be connected.
      if (auth && !auth.loggedIn && auth.loginCommand) {
        list.append(h('p', {class: 'section-sub'}, [`connect it with:  ${auth.loginCommand}`]));
      }
      if (auth?.detail) list.append(h('p', {class: 'section-sub'}, [auth.detail]));
    });
    const manualAccounts = chain.accounts.filter(account => !chain.chain.includes(account.id));
    if (manualAccounts.length > 0) {
      list.append(h('p', {class: 'field-label'}, ['separate logins — manual session selection']));
      list.append(h('p', {class: 'section-sub'}, ['These profiles stay out of automatic fallback. Select one explicitly when starting a new session.']));
      for (const account of manualAccounts) {
        const auth = authByAccount[account.id];
        const connection = auth ? (auth.loggedIn ? 'connected' : 'not connected') : '';
        list.append(h('div', {class: 'option-row'}, [
          h('span', {class: 'label'}, [account.label]),
          h('span', {class: auth && !auth.loggedIn ? 'error' : 'meta'}, [[account.mode, account.model ? `model ${account.model}` : '', connection, 'manual only'].filter(Boolean).join(' · ')]),
          h('div', {class: 'actions'}, [removeButton(account)])
        ]));
        if (auth && !auth.loggedIn && auth.loginCommand) {
          list.append(h('p', {class: 'section-sub'}, [`connect it with:  ${auth.loginCommand}`]));
        }
      }
    }
    if (chain.accounts.length === 0) list.append(h('p', {class: 'section-sub'}, ['No accounts yet — add one below or from onboarding.']));
  }
  renderList();

  main.append(h('label', {class: 'field-label'}, ['when a credential hits its limit']));
  const policies: Array<{id: CredentialChainState['fallbackPolicy']; label: string}> = [
    {id: 'always-ask', label: 'always ask'},
    {id: 'always-switch', label: 'always switch automatically'},
    {id: 'never-switch', label: 'never switch (just wait)'}
  ];
  const policyRow = h('div', {class: 'cards-row'});
  for (const policy of policies) {
    const card = h('div', {class: `card selectable${chain.fallbackPolicy === policy.id ? ' selected' : ''}`}, [policy.label]);
    card.addEventListener('click', async () => {
      await api.setFallbackPolicy(credentialProvider, policy.id);
      chain.fallbackPolicy = policy.id;
      for (const sibling of policyRow.children) sibling.classList.remove('selected');
      card.classList.add('selected');
    });
    policyRow.append(card);
  }
  main.append(policyRow);
  const activeLabel = chain.accounts.find(account => account.id === chain.activeAccountId)?.label ?? 'the provider CLI login';
  main.append(h('p', {class: 'section-sub'}, [chain.fallbackPolicy === 'always-ask'
    ? `if ${activeLabel} reaches a limit, Fluent asks before trying the next credential, then reverts after reset.`
    : chain.fallbackPolicy === 'always-switch'
      ? `if ${activeLabel} reaches a limit, Fluent tries the next credential and reverts after reset.`
      : `if ${activeLabel} reaches a limit, Fluent waits and does not switch credentials.`]));

  main.append(h('label', {class: 'field-label'}, ['add an account']));
  const modeInput = h('select') as HTMLSelectElement;
  // Claude is the only runtime where we have verified isolated config directories for distinct
  // subscription / Console profiles. Other providers remain honest API-key paths until their
  // respective CLIs expose equivalent profile isolation.
  const modes: CredentialMode[] = credentialProvider === 'claude'
    ? ['subscription', 'platform-credits', 'api-key']
    : ['api-key'];
  for (const mode of modes) modeInput.append(h('option', {value: mode}, [mode === 'platform-credits' ? 'platform API credits' : mode]));
  const labelInput = h('input', {type: 'text', placeholder: 'label'});
  const keyInput = h('input', {type: 'password', placeholder: credentialProvider === 'claude' ? 'sk-ant-...' : 'sk-...'});
  const linkedProvider = credentialProvider === 'qwen' || credentialProvider === 'glm' || credentialProvider === 'nvidia'
    ? credentialProvider
    : undefined;
  const modelLinked = linkedProvider !== undefined;
  const linkDefaults = linkedProvider ? modelLinkDefaults[linkedProvider] : undefined;
  const baseUrlInput = h('input', {type: 'url', value: linkDefaults?.endpoint ?? '', placeholder: modelLinked ? 'OpenAI-compatible endpoint' : 'base URL (optional — e.g. OpenRouter preset)'});
  const modelInput = h('input', {type: 'text', value: linkDefaults?.model ?? '', placeholder: 'model id'});
  const identityInput = h('select') as HTMLSelectElement;
  identityInput.append(h('option', {value: 'automatic'}, ['identity · automatic']));
  identityInput.append(h('option', {value: 'new'}, ['identity · separate login']));
  const seenIdentities = new Set<string>();
  for (const account of chain.accounts) {
    if (seenIdentities.has(account.identityId)) continue;
    seenIdentities.add(account.identityId);
    identityInput.append(h('option', {value: `link:${account.id}`}, [`identity · same login as ${account.label}`]));
  }
  const status = h('p', {class: 'section-sub'}, []);
  const addButton = h('button', {class: 'btn'}, ['add account']);
  const syncAccountForm = () => {
    const apiKeyMode = modeInput.value === 'api-key';
    keyInput.hidden = !apiKeyMode;
    baseUrlInput.hidden = !apiKeyMode || (credentialProvider !== 'claude' && !modelLinked);
    modelInput.hidden = !apiKeyMode || !modelLinked;
    addButton.textContent = apiKeyMode ? 'save API key' : 'add CLI profile';
    status.textContent = apiKeyMode
      ? modelLinked
        ? 'Keys are stored in the operating-system credential store. This account launches OpenCode with its own model and endpoint.'
        : 'Keys are stored in the operating-system credential store.'
      : 'This creates an isolated CLI profile. Fluent shows the exact provider login command after saving.';
  };
  modeInput.addEventListener('change', syncAccountForm);
  syncAccountForm();
  addButton.addEventListener('click', async () => {
    const mode = modeInput.value as CredentialMode;
    const apiKey = keyInput.value.trim();
    if (mode === 'api-key' && !apiKey) return keyInput.focus();
    const identityChoice = identityInput.value;
    try {
      await api.upsertAccount({
        provider: credentialProvider,
        id: crypto.randomUUID(),
        mode,
        label: labelInput.value.trim() || (mode === 'api-key' ? 'API key' : mode === 'subscription' ? 'subscription' : 'platform API credits'),
        apiKey: mode === 'api-key' ? apiKey : undefined,
        baseUrl: mode === 'api-key' && (credentialProvider === 'claude' || modelLinked) ? baseUrlInput.value.trim() || undefined : undefined,
        model: mode === 'api-key' && modelLinked ? modelInput.value.trim() || undefined : undefined,
        sameIdentityAs: identityChoice.startsWith('link:') ? identityChoice.slice('link:'.length) : undefined,
        forceNewIdentity: identityChoice === 'new'
      });
      await renderCredentials(replaceMain(main));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.className = 'error';
    }
  });
  main.append(h('div', {class: 'field'}, [modeInput, labelInput, identityInput, keyInput, modelInput, baseUrlInput, addButton, status]));
}
