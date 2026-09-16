// --- Usage observatory -------------------------------------------------------
import {api} from '../api';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {h, markEl, button, askConfirm, showActionError, showNotice, actionErrorText, relativeTime, formatTokens, formatUsd, formatPercent, bytes, duration, providerLabel, providerColor, modelLinkDefaults, accountLabel, verificationPill, laneReady, quotaLabel, directoryField, pickDirectory, workspaceFolderName, segmented, isLive} from '../ui';
import {metricCard, sparklineChart, lineChart} from '../charts';

import type {SessionSummary} from '../api';

export async function renderUsage(main: HTMLElement) {
  const [hardware, sessions, software, usage, resources] = await Promise.all([api.hardwareSnapshot(), api.listSessions(), api.softwareSnapshot(), api.usageSnapshot(), api.resourceSnapshot().catch(() => undefined)]);
  const {current, history} = hardware;
  const refreshButton = button('refresh', () => void refresh());
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [h('h1', {class: 'section-title'}, [markEl(), 'usage observatory']), h('p', {class: 'section-sub'}, ['local-only hardware and session health · provider token telemetry connects when adapters expose it'])]),
      refreshButton
    ])
  );
  const memoryPercent = current.memoryTotalBytes ? (current.memoryUsedBytes / current.memoryTotalBytes) * 100 : 0;
  main.append(h('div', {class: 'metrics-grid'}, [
    metricCard('cpu process share', `${current.cpuPercent.toFixed(1)}%`, sparklineChart(history.map(sample => sample.cpuPercent), 'var(--success)')),
    metricCard('memory', `${bytes(current.memoryUsedBytes)} / ${bytes(current.memoryTotalBytes)}`, sparklineChart(history.map(sample => sample.memoryUsedBytes), 'var(--fg-muted)')),
    metricCard('disk used', `${bytes(current.diskUsedBytes)} / ${bytes(current.diskTotalBytes)}`, current.diskTotalBytes ? `${((current.diskUsedBytes! / current.diskTotalBytes) * 100).toFixed(0)}% capacity` : 'not available'),
    metricCard('uptime', duration(current.uptimeSeconds), `${current.platform} · ${current.arch}`)
  ]));
  main.append(h('div', {class: 'cards-row'}, [
    h('div', {class: 'card'}, [
      h('h3', {}, ['hardware trace']),
      h('p', {class: 'trace cpu'}, ['cpu', sparklineChart(history.map(sample => sample.cpuPercent), 'var(--success)')]),
      h('p', {class: 'trace memory'}, ['memory', sparklineChart(history.map(sample => sample.memoryUsedBytes), 'var(--fg-muted)')]),
      h('p', {class: 'section-sub'}, [`load average  ${current.loadAverage.map(value => value.toFixed(2)).join(' · ')}  ·  fluentd rss ${bytes(current.processRssBytes)}`])
    ]),
    h('div', {class: 'card'}, [
      h('h3', {}, ['agent capacity advisory']),
      h('p', {}, [memoryPercent > 85 || current.cpuPercent > 85 ? 'running low on headroom — hold new agents until load falls.' : 'headroom looks healthy — additional agents remain advisory, not guaranteed.']),
      h('p', {class: 'section-sub'}, [`${sessions.filter(session => session.status === 'running').length} live sessions · no automatic throttle`])
    ])
  ]));
  if (usage.sessions.length) {
    main.append(h('div', {class: 'card'}, [
      h('h3', {}, ['provider usage · each provider\'s own telemetry']),
      h('div', {class: 'table-head muted'}, ['model · context · tokens · cache · cost · windows · updated']),
      ...usage.sessions.map(item => h('div', {class: 'usage-row'}, [
        h('strong', {}, [item.model ?? providerLabel[item.provider]]),
        // Coral is reserved for actions/alerts/thresholds (AGENTS.md), never an ordinary data
        // series — this is a routine per-session trend, so it stays in the muted trace palette.
        h('span', {class: 'trace'}, [`context ${item.contextPercent?.toFixed(0) ?? '—'}%`, sparklineChart(item.history.map(sample => sample.contextPercent ?? NaN), 'var(--fg-muted)')]),
        h('span', {class: 'section-sub'}, [`input ${formatTokens(item.inputTokens)} · output ${formatTokens(item.outputTokens)} · cache ${item.cacheHitRatio === undefined ? '—' : `${(item.cacheHitRatio * 100).toFixed(0)}%`} · cost ${item.costUsd === undefined ? '—' : `$${item.costUsd.toFixed(2)}`}`]),
        h('span', {class: 'section-sub'}, [`${quotaLabel(item.quota?.primary)} · ${quotaLabel(item.quota?.secondary)} · ${relativeTime(item.updatedAt)}`])
      ]))
    ]));
  } else {
    main.append(h('div', {class: 'card'}, [
      h('h3', {}, ['provider usage']),
      h('p', {class: 'section-sub'}, ['Claude Code usage will appear after its first response in a Fluent-launched session. Existing custom Claude status lines are preserved and are not replaced.'])
    ]));
  }
  main.append(h('div', {class: 'card'}, [
    h('h3', {}, ['software health']),
    h('p', {class: 'section-sub'}, [`${software.hostname} · kernel ${software.kernel} · Node ${software.nodeVersion} · fluentd ${software.daemonPid}`]),
    h('p', {class: 'section-sub'}, [software.git ? `git ${software.git.replace(/\n/g, ' · ')}` : 'git state unavailable from fluentd working directory']),
    ...software.providers.map(provider => h('p', {class: 'section-sub'}, [`${provider.label}  ${provider.installed ? provider.version || 'installed' : 'not installed'}`]))
  ]));
  if (resources) {
    const top = [...resources.processes].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 5);
    main.append(h('div', {class: 'card'}, [
      h('h3', {}, ['agent process resources']),
      h('p', {class: 'section-sub'}, [`${resources.retainedProcessCount} retained of ${resources.scannedProcessCount} scanned processes · sample ${resources.sequence}`]),
      ...top.map(process => h('p', {class: 'section-sub'}, [`${process.name} (${process.pid}) · ${process.cpuPercent.toFixed(1)}% CPU · ${bytes(process.residentBytes)} RSS · read ${bytes(process.ioReadBytes)} · write ${bytes(process.ioWriteBytes)}`]))
    ]));
  }
}
