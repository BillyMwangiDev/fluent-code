import {api, type CredentialChainState, type ProviderId} from '../api';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {button, h, markEl} from '../ui';

/** The packaged daemon is started by Tauri immediately before the webview loads. Give its
 * owner-local socket a bounded moment to come up instead of presenting a false startup failure
 * on a fast first render. A genuine daemon failure remains visible and retryable afterwards. */
async function waitForLocalDaemon() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      return await api.ping();
    } catch (error) {
      lastError = error;
      if (attempt < 24) await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

export async function renderSplash(main: HTMLElement) {
  const container = h('div', {class: 'splash'});
  main.append(container);
  const wordmark = h('div', {class: 'wordmark'}, [markEl(), 'fluent code']);
  container.append(wordmark, h('p', {class: 'version'}, ['starting local engine…']));

  let ping: {ok: boolean; pid: number};
  try {
    ping = await waitForLocalDaemon();
  } catch (error) {
    container.innerHTML = '';
    container.append(wordmark, h('p', {class: 'error'}, [error instanceof Error ? error.message : String(error)]), button('retry', () => void refresh(), {class: 'btn primary'}));
    return;
  }

  const [chains, firstProbe] = await Promise.all([api.listCredentials().catch(() => [] as CredentialChainState[]), api.listProviders().catch(() => [])]);
  // fluentd's first `--version` probe after it starts can come back empty; a second look a moment
  // later is cheap, and it keeps a machine with Claude Code installed from being sent to onboarding.
  let installed = firstProbe;
  if (!installed.some(provider => provider.installed)) {
    await new Promise(resolve => setTimeout(resolve, 800));
    installed = await api.listProviders().catch(() => firstProbe);
  }
  const providers: Array<{id: ProviderId; label: string}> = [
    {id: 'claude', label: 'anthropic claude'},
    {id: 'codex', label: 'openai codex'},
    {id: 'gemini', label: 'google gemini'},
    {id: 'qwen', label: 'qwen'},
    {id: 'glm', label: 'z.ai glm'},
    {id: 'nvidia', label: 'nvidia nim'}
  ];

  container.innerHTML = '';
  container.append(
    wordmark,
    h('p', {class: 'version'}, [`fluentd connected · pid ${ping.pid}`]),
    h('div', {class: 'providers'}, providers.map(provider => {
      const chain = chains.find(c => c.provider === provider.id);
      const connected = Boolean(chain?.activeAccountId);
      return h('span', {class: 'badge'}, [h('span', {class: `dot${connected ? ' on' : ''}`}), provider.label]);
    })),
    h('p', {class: 'prompt'}, ['press ', h('kbd', {}, ['enter']), ' to continue'])
  );

  // A CLI that is installed can already log in on its own, so the workspace is the right landing;
  // onboarding is for a machine with nothing to run yet.
  // Someone who already chose a workspace has used Fluent before; the workspace is home, and
  // credentials stay one click away in the rail. Onboarding is for a first run with nothing to run.
  const canStart = Boolean(prefs.workspacePath) || chains.some(chain => chain.accounts.length > 0) || installed.some(provider => provider.installed);
  let advanced = false;
  const advance = () => {
    if (advanced) return;
    advanced = true;
    navigate(canStart ? {name: 'orchestration'} : {name: 'onboarding'});
  };
  container.addEventListener('click', advance);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      document.removeEventListener('keydown', onKey);
      advance();
    }
  };
  document.addEventListener('keydown', onKey);
  // A returning user (a workspace already chosen) has seen this screen before — let it flash the
  // provider badges, then move on by itself. A first run has nothing saved yet and always waits.
  if (prefs.workspacePath && canStart) setTimeout(advance, 400);
}
