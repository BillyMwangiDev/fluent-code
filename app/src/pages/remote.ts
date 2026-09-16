// --- Remote servers ------------------------------------------------------------
import {api} from '../api';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {h, markEl, button, askConfirm, showActionError, showNotice, actionErrorText, relativeTime, formatTokens, formatUsd, formatPercent, bytes, duration, providerLabel, providerColor, modelLinkDefaults, accountLabel, verificationPill, laneReady, quotaLabel, directoryField, pickDirectory, workspaceFolderName, segmented, isLive} from '../ui';
import {metricCard, sparklineChart, lineChart} from '../charts';

import {activeRemoteSocket, selectRemoteSocket} from '../api';

export async function renderRemote(main: HTMLElement) {
  const profiles = await api.listRemotes();
  const selectedSocket = activeRemoteSocket();
  const name = h('input', {type: 'text', placeholder: 'server name'});
  const host = h('input', {type: 'text', placeholder: 'user@host'});
  const port = h('input', {type: 'number', value: '22', min: '1', max: '65535', step: '1', placeholder: 'SSH port'}) as HTMLInputElement;
  const remoteSocket = h('input', {type: 'text', value: '/tmp/fluent-code.sock', placeholder: 'remote Fluent socket path'}) as HTMLInputElement;
  const autoReconnect = h('input', {type: 'checkbox'}) as HTMLInputElement;
  const setupStatus = h('p', {class: 'section-sub'}, ['Use the remote daemon’s actual Unix-socket path. Fluent verifies its protocol before it can become the active target.']);
  const add = h('button', {class: 'btn primary'}, ['add SSH server']);
  add.addEventListener('click', async () => {
    if (!name.value.trim() || !host.value.trim()) return host.focus();
    try {
      await api.saveRemote({name: name.value.trim(), host: host.value.trim(), port: Number(port.value), remoteSocket: remoteSocket.value.trim(), autoReconnect: autoReconnect.checked});
      void refresh();
    } catch (error) {
      setupStatus.textContent = error instanceof Error ? error.message : String(error);
      setupStatus.className = 'error';
    }
  });
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [
        h('h1', {class: 'section-title'}, [markEl(), 'remote servers']),
        h('p', {class: 'section-sub'}, ['connects through SSH Unix-socket forwarding; Fluent never exposes a daemon port publicly.'])
      ])
    ]),
    h('div', {class: 'card remote-connect-card'}, [
      h('h3', {}, ['add a remote target']),
      h('p', {class: 'section-sub'}, ['Name a server, then use your existing SSH identity to establish an owner-controlled tunnel. Automatic reconnect is opt-in and bounded.']),
      h('div', {class: 'field'}, [name, host, port, remoteSocket, h('label', {class: 'section-sub'}, [autoReconnect, ' reconnect automatically after a tunnel failure']), add, setupStatus])
    ])
  );
  if (profiles.length === 0) {
    main.append(h('div', {class: 'empty-state remote-empty'}, ['No remote servers configured. Your local machine remains the active target.']));
  }
  for (const profile of profiles) {
    const action = h('button', {class: profile.status === 'connected' ? 'btn' : 'btn primary'}, [profile.status === 'connected' ? 'disconnect' : 'connect']);
    action.addEventListener('click', async () => {
      if (profile.status === 'connected') {
        await api.disconnectRemote(profile.id);
        if (selectedSocket === profile.localSocket) selectRemoteSocket();
      } else {
        await api.connectRemote(profile.id);
        // SSH forwarding proves remote fluentd is reachable asynchronously. Once it is
        // connected, "use this server" becomes available without guessing at a target.
        setTimeout(() => void refresh(), 1200);
      }
      void refresh();
    });
    const useHere = h('button', {class: `btn${selectedSocket === profile.localSocket ? ' primary' : ''}`}, [selectedSocket === profile.localSocket ? 'using this server' : 'use this server']);
    useHere.disabled = profile.status !== 'connected';
    useHere.addEventListener('click', () => { selectRemoteSocket(profile.localSocket); void refresh(); });
    const removeProfile = h('button', {class: 'btn danger', type: 'button'}, ['remove']);
    removeProfile.addEventListener('click', async () => {
      if (!(await askConfirm({title: `remove ${profile.name}`, body: `Remove the saved SSH profile for ${profile.host}? Its tunnel closes if it is open. The remote daemon and its sessions keep running.`, confirmLabel: 'remove profile', danger: true}))) return;
      removeProfile.disabled = true;
      try {
        await api.removeRemote(profile.id);
        if (selectedSocket === profile.localSocket) selectRemoteSocket();
        void refresh();
      } catch (error) {
        showActionError(error);
        removeProfile.disabled = false;
      }
    });
    main.append(h('div', {class: 'option-row'}, [
      h('span', {class: 'label'}, [profile.name]),
      h('span', {class: 'meta'}, [`${profile.host}:${profile.port} · ${profile.remoteSocket} · ${profile.autoReconnect ? 'auto-reconnect' : 'manual reconnect'} · ${profile.status}${profile.error ? ` · ${profile.error}` : ''}`]),
      useHere,
      action,
      removeProfile
    ]));
  }
  if (selectedSocket) {
    try {
      const [hardware, software] = await Promise.all([api.hardwareSnapshot(), api.softwareSnapshot()]);
      const memory = `${bytes(hardware.current.memoryUsedBytes)} / ${bytes(hardware.current.memoryTotalBytes)}`;
      main.append(h('div', {class: 'cards-row'}, [
        h('div', {class: 'card'}, [
          h('h3', {}, ['active remote hardware']),
          h('p', {class: 'trace cpu'}, ['cpu', sparklineChart(hardware.history.map(sample => sample.cpuPercent), 'var(--success)')]),
          h('p', {class: 'trace memory'}, ['memory', sparklineChart(hardware.history.map(sample => sample.memoryUsedBytes), 'var(--fg-muted)')]),
          h('p', {class: 'section-sub'}, [`${hardware.current.cpuPercent.toFixed(1)}% fluentd CPU · ${memory} memory · uptime ${duration(hardware.current.uptimeSeconds)}`])
        ]),
        h('div', {class: 'card'}, [
          h('h3', {}, ['active remote software']),
          h('p', {class: 'section-sub'}, [`${software.hostname} · ${software.kernel} · Node ${software.nodeVersion}`]),
          ...software.providers.map(provider => h('p', {class: 'section-sub'}, [`${provider.label}  ${provider.installed ? provider.version || 'installed' : 'not installed'}`]))
        ])
      ]));
    } catch (error) {
      main.append(h('p', {class: 'error'}, [`remote observability unavailable: ${error instanceof Error ? error.message : String(error)}`]));
    }
  }
}
