import '@xterm/xterm/css/xterm.css';
import '@fontsource/archivo/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/700.css';
import {isPermissionGranted, requestPermission, sendNotification} from '@tauri-apps/plugin-notification';
import {onSessionAttention} from './api';
import {applyAppearance, prefs} from './prefs';
import {route, setRenderer, type Route} from './router';
import {installGlobalShortcuts, renderRail, renderTopbar} from './shell';
import {renderActiveSession} from './session-view';
import {renderWorkspace} from './workspace';
import {h, providerLabel, sessionName, showNotice} from './ui';
import {renderSplash} from './pages/splash';
import {renderOnboarding} from './pages/onboarding';
import {renderSessions} from './pages/sessions';
import {renderNewSession} from './pages/new-session';
import {renderCredentials} from './pages/credentials';
import {renderUsage} from './pages/usage';
import {renderSpend} from './pages/spend';
import {renderSourceControl} from './pages/source-control';
import {renderCatalog} from './pages/catalog';
import {renderThemes} from './pages/themes';
import {renderDesignWorkspace} from './pages/design';
import {renderPreview} from './pages/preview';
import {renderRemote} from './pages/remote';

const root = document.getElementById('app')!;

applyAppearance();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (prefs.appearance === 'system') applyAppearance();
});

const attentionTitles = {finished: 'finished', failed: 'stopped with an error', 'needs-input': 'needs you'} as const;

/**
 * A lane that finished, failed, or is waiting on the user reaches them even while Fluent is in the
 * background: a system notification then, an in-app notice otherwise. The page already showing that
 * lane needs neither.
 */
void onSessionAttention(async attention => {
  const name = sessionName(attention.summary);
  const title = `${providerLabel[attention.summary.provider]} lane ${attentionTitles[attention.reason]}`;
  const body = attention.detail ? `${name} — ${attention.detail}` : name;
  const current = route();
  if (document.hasFocus()) {
    if (current.name === 'active-session' && current.sessionId === attention.sessionId) return;
    if (current.name === 'orchestration') return; // the tile itself shows it
    showNotice(`${title}: ${body}`);
    return;
  }
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted) sendNotification({title, body});
    else showNotice(`${title}: ${body}`);
  } catch {
    showNotice(`${title}: ${body}`);
  }
}).catch(() => undefined);

async function render(current: Route) {
  root.innerHTML = '';
  const main = h('main');
  // `main` is the full-width scroll owner; `.page` is the width-capped wrapper document-style
  // routes render into. The workspace and a single session own the whole plane instead, and the
  // splash has no rail or scroll shell at all.
  let page: HTMLElement;
  if (current.name === 'splash') {
    main.classList.add('splash-main');
    root.append(main);
    page = main;
  } else {
    root.append(renderTopbar(), h('div', {class: 'app-shell'}, [renderRail(), main]));
    if (current.name === 'orchestration' || current.name === 'active-session') {
      main.classList.add('main-plane');
      page = main;
    } else {
      page = h('div', {class: 'page'});
      main.append(page);
    }
  }

  try {
    switch (current.name) {
      case 'splash': await renderSplash(page); break;
      case 'onboarding': await renderOnboarding(page); break;
      case 'sessions': await renderSessions(page); break;
      case 'new-session': await renderNewSession(page); break;
      case 'active-session': await renderActiveSession(page, current.sessionId); break;
      case 'credentials': await renderCredentials(page); break;
      case 'usage': await renderUsage(page); break;
      case 'spend': await renderSpend(page); break;
      case 'source-control': await renderSourceControl(page); break;
      case 'catalog': await renderCatalog(page); break;
      case 'themes': await renderThemes(page); break;
      case 'orchestration': await renderWorkspace(page, {focus: current.focus}); break;
      case 'design': await renderDesignWorkspace(page); break;
      case 'preview': await renderPreview(page); break;
      case 'remote': await renderRemote(page); break;
    }
  } catch (error) {
    page.innerHTML = '';
    page.append(h('p', {class: 'splash error'}, [error instanceof Error ? error.message : String(error)]));
  }
}

setRenderer(render);
installGlobalShortcuts();
void render(route());
