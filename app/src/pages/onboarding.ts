// --- Onboarding ------------------------------------------------------------
import {api} from '../api';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {h, markEl, button, askConfirm, showActionError, showNotice, actionErrorText, relativeTime, formatTokens, formatUsd, formatPercent, bytes, duration, providerLabel, providerColor, modelLinkDefaults, accountLabel, verificationPill, laneReady, quotaLabel, directoryField, pickDirectory, workspaceFolderName, segmented, isLive} from '../ui';
import {metricCard, sparklineChart, lineChart} from '../charts';


export async function renderOnboarding(main: HTMLElement) {
  main.append(
    h('h1', {class: 'section-title'}, [markEl(), 'connect a provider']),
    h('p', {class: 'section-sub'}, ['choose an authentication method to get started'])
  );

  const cards = h('div', {class: 'cards-row'});
  main.append(cards);

  // Provider CLIs retain their own login flows; Fluent launches each one unchanged and supplies
  // an explicitly selected secure API-key credential only when the user has configured it.
  const dirInput = h('input', {type: 'text', placeholder: '/path/to/project', value: prefs.workspacePath}) as HTMLInputElement;
  const loginButton = h('button', {class: 'btn primary'}, ['connect via CLI login']);
  loginButton.addEventListener('click', async () => {
    const directory = dirInput.value.trim();
    if (!directory) return dirInput.focus();
    prefs.workspacePath = directory;
    const summary = await api.createSession({provider: 'claude', directory});
    navigate({name: 'active-session', sessionId: summary.id});
  });

  const keyLabel = h('input', {type: 'text', placeholder: 'label (e.g. personal)'});
  const keyInput = h('input', {type: 'password', placeholder: 'sk-ant-...'});
  const keyStatus = h('p', {class: 'section-sub'}, []);
  const keyButton = h('button', {class: 'btn'}, ['save API key']);
  keyButton.addEventListener('click', async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) return keyInput.focus();
    await api.upsertAccount({
      provider: 'claude',
      id: crypto.randomUUID(),
      mode: 'api-key',
      label: keyLabel.value.trim() || 'API key',
      apiKey
    });
    keyStatus.textContent = 'saved — manage precedence in Credentials';
    keyInput.value = '';
  });
  const routerLabel = h('input', {type: 'text', placeholder: 'label (e.g. team router)'});
  const routerKey = h('input', {type: 'password', placeholder: 'sk-or-...'});
  const routerStatus = h('p', {class: 'section-sub'}, []);
  const routerButton = h('button', {class: 'btn'}, ['save OpenRouter key']);
  routerButton.addEventListener('click', async () => {
    const apiKey = routerKey.value.trim();
    if (!apiKey) return routerKey.focus();
    await api.upsertAccount({
      provider: 'claude',
      id: crypto.randomUUID(),
      mode: 'api-key',
      label: routerLabel.value.trim() || 'OpenRouter',
      apiKey,
      baseUrl: 'https://openrouter.ai/api'
    });
    routerStatus.textContent = 'saved securely — select OpenRouter in the Claude Code account chain';
    routerKey.value = '';
  });
  const codexKeyLabel = h('input', {type: 'text', placeholder: 'label (e.g. OpenAI work)'});
  const codexKey = h('input', {type: 'password', placeholder: 'sk-...'});
  const codexStatus = h('p', {class: 'section-sub'}, []);
  const codexKeyButton = h('button', {class: 'btn'}, ['save Codex API key']);
  codexKeyButton.addEventListener('click', async () => {
    const apiKey = codexKey.value.trim();
    if (!apiKey) return codexKey.focus();
    await api.upsertAccount({
      provider: 'codex',
      id: crypto.randomUUID(),
      mode: 'api-key',
      label: codexKeyLabel.value.trim() || 'OpenAI API key',
      apiKey
    });
    codexStatus.textContent = 'saved securely — select it when starting a Codex session';
    codexKey.value = '';
  });
  const codexLogin = h('button', {class: 'btn primary'}, ['connect via Codex login']);
  codexLogin.addEventListener('click', async () => {
    const directory = dirInput.value.trim();
    if (!directory) return dirInput.focus();
    const summary = await api.createSession({provider: 'codex', directory});
    navigate({name: 'active-session', sessionId: summary.id});
  });
  const geminiKeyLabel = h('input', {type: 'text', placeholder: 'label (e.g. Google AI Studio)'});
  const geminiKey = h('input', {type: 'password', placeholder: 'AIza...'});
  const geminiStatus = h('p', {class: 'section-sub'}, []);
  const geminiKeyButton = h('button', {class: 'btn'}, ['save Gemini API key']);
  geminiKeyButton.addEventListener('click', async () => {
    const apiKey = geminiKey.value.trim();
    if (!apiKey) return geminiKey.focus();
    await api.upsertAccount({
      provider: 'gemini',
      id: crypto.randomUUID(),
      mode: 'api-key',
      label: geminiKeyLabel.value.trim() || 'Gemini API key',
      apiKey
    });
    geminiStatus.textContent = 'saved securely — select it when starting a Gemini session';
    geminiKey.value = '';
  });
  const geminiLogin = h('button', {class: 'btn primary'}, ['connect via Gemini login']);
  geminiLogin.addEventListener('click', async () => {
    const directory = dirInput.value.trim();
    if (!directory) return dirInput.focus();
    const summary = await api.createSession({provider: 'gemini', directory});
    navigate({name: 'active-session', sessionId: summary.id});
  });

  const modelLinkCard = (provider: 'qwen' | 'glm' | 'nvidia', subtitle: string) => {
    const defaults = modelLinkDefaults[provider];
    const labelInput = h('input', {type: 'text', placeholder: 'account label (e.g. work)'});
    const keyInput = h('input', {type: 'password', placeholder: defaults.keyPlaceholder});
    const modelInput = h('input', {type: 'text', value: defaults.model, placeholder: 'model id'});
    const endpointInput = h('input', {type: 'url', value: defaults.endpoint, placeholder: 'OpenAI-compatible endpoint'});
    const status = h('p', {class: 'section-sub'}, []);
    const save = h('button', {class: 'btn'}, ['save API key']);
    save.addEventListener('click', async () => {
      const apiKey = keyInput.value.trim();
      if (!apiKey) return keyInput.focus();
      const model = modelInput.value.trim();
      if (!model) return modelInput.focus();
      const baseUrl = endpointInput.value.trim();
      if (!baseUrl) return endpointInput.focus();
      await api.upsertAccount({
        provider,
        id: crypto.randomUUID(),
        mode: 'api-key',
        label: labelInput.value.trim() || `${providerLabel[provider]} API key`,
        apiKey,
        model,
        baseUrl
      });
      status.textContent = 'saved securely — select this account when starting a session';
      keyInput.value = '';
    });
    return h('div', {class: 'card'}, [
      h('h3', {}, [providerLabel[provider]]),
      h('p', {class: 'subtitle'}, [subtitle]),
      h('div', {class: 'field'}, [
        h('label', {class: 'field-label'}, ['API key · model · endpoint']),
        labelInput,
        keyInput,
        modelInput,
        endpointInput,
        save,
        status,
        h('p', {class: 'section-sub'}, ['Uses the locally installed OpenCode agent; the endpoint and model stay explicit per account.'])
      ])
    ]);
  };

  cards.append(
    h('div', {class: 'card'}, [
      h('h3', {}, ['Claude Code']),
      h('p', {class: 'subtitle'}, ['Anthropic']),
      h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['CLI login — working directory']), directoryField(dirInput, path => { prefs.workspacePath = path; }), h('p', {class: 'section-sub'}, ['browse folders on this computer, or enter a path']), loginButton]),
      h('div', {class: 'field'}, [
        h('label', {class: 'field-label'}, ['or use an API key']),
        keyLabel,
        keyInput,
        keyButton,
        keyStatus
      ])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['Codex']),
      h('p', {class: 'subtitle'}, ['OpenAI · subscription login or API key']),
      h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['CLI login — same working directory']), codexLogin]),
      h('div', {class: 'field'}, [codexKeyLabel, codexKey, codexKeyButton, codexStatus])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['Gemini CLI']),
      h('p', {class: 'subtitle'}, ['Google login or Gemini API key']),
      h('div', {class: 'field'}, [h('label', {class: 'field-label'}, ['CLI login — same working directory']), geminiLogin]),
      h('div', {class: 'field'}, [geminiKeyLabel, geminiKey, geminiKeyButton, geminiStatus])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['OpenRouter']),
      h('p', {class: 'subtitle'}, ['Claude Code compatibility preset · API key']),
      h('div', {class: 'field'}, [
        routerLabel,
        routerKey,
        routerButton,
        routerStatus
      ])
    ]),
    modelLinkCard('qwen', 'Alibaba Cloud Model Studio · OpenAI-compatible API'),
    modelLinkCard('glm', 'Z.AI Coding Plan · OpenAI-compatible API'),
    modelLinkCard('nvidia', 'NVIDIA NIM · hosted or self-hosted OpenAI-compatible API')
  );

  const skip = h('button', {class: 'btn'}, ['skip for now']);
  skip.addEventListener('click', () => navigate({name: 'sessions'}));
  main.append(h('div', {class: 'toolbar'}, [h('span', {}, []), skip]));
}
