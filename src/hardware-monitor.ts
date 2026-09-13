import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {arch, cpus, freemem, loadavg, platform, totalmem, uptime} from 'node:os';
import type {HardwareSample, HardwareSnapshot} from './daemon-protocol.js';

const run = promisify(execFile);

export class HardwareMonitor {
  private history: HardwareSample[] = [];
  private lastCpu = process.cpuUsage();
  private lastAt = process.hrtime.bigint();
  private timer?: NodeJS.Timeout;

  start() {
    void this.capture();
    this.timer = setInterval(() => void this.capture(), 5_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): HardwareSnapshot {
    const current = this.history.at(-1) ?? this.sample();
    return {current, history: this.history.slice(-60)};
  }

  private sample(): HardwareSample {
    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage(this.lastCpu);
    const elapsedMicros = Number(now - this.lastAt) / 1_000;
    this.lastCpu = process.cpuUsage();
    this.lastAt = now;
    const cpuPercent = elapsedMicros > 0 ? Math.min(100, ((cpu.user + cpu.system) / elapsedMicros / Math.max(cpus().length, 1)) * 100) : 0;
    return {
      capturedAt: new Date().toISOString(),
      cpuPercent,
      loadAverage: loadavg(),
      memoryUsedBytes: totalmem() - freemem(),
      memoryTotalBytes: totalmem(),
      processRssBytes: process.memoryUsage().rss,
      uptimeSeconds: uptime(),
      platform: platform(),
      arch: arch()
    };
  }

  private async capture() {
    const sample = this.sample();
    try {
      const {stdout} = await run('df', ['-k', process.cwd()]);
      const fields = stdout.trim().split(/\n/).at(-1)?.trim().split(/\s+/) ?? [];
      if (fields.length >= 5) {
        sample.diskTotalBytes = Number(fields[1]) * 1024;
        sample.diskUsedBytes = Number(fields[2]) * 1024;
      }
    } catch {
      // Disk statistics are advisory; retain the CPU/memory sample if df is unavailable.
    }
    this.history = [...this.history, sample].slice(-60);
  }
}
