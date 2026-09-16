import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {arch, cpus, freemem, loadavg, platform, totalmem, uptime} from 'node:os';
import type {HardwareSample, HardwareSnapshot} from './daemon-protocol.js';

const run = promisify(execFile);

/**
 * macOS counts file cache and compressor-backed pages as used, so `os.freemem()` is a few hundred
 * megabytes on any Mac that has been up for a while — which made every capacity verdict "no
 * headroom". `kern.memorystatus_level` is the kernel's own memory-free percentage (the figure
 * `memory_pressure` prints), the number that actually says whether another process fits.
 */
export function availableMemoryFromStatusLevel(level: string, memoryTotalBytes: number): number | undefined {
  const percent = Number(level.trim());
  if (level.trim() === '' || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  return Math.round(memoryTotalBytes * percent / 100);
}

/** Some sandboxed or containerized Node runtimes deny uv_uptime(). Observability must remain
 * advisory: losing one host metric must never prevent fluentd from starting. */
function safeUptime(): number {
  try { return uptime(); }
  catch { return 0; }
}

export class HardwareMonitor {
  private history: HardwareSample[] = [];
  private lastCpu = process.cpuUsage();
  private lastAt = process.hrtime.bigint();
  private timer?: NodeJS.Timeout;
  /** Bytes another process could use, from the platform's own figure when Node's is misleading. */
  private availableBytes?: number;

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
      memoryUsedBytes: totalmem() - (this.availableBytes ?? freemem()),
      memoryTotalBytes: totalmem(),
      processRssBytes: process.memoryUsage().rss,
      uptimeSeconds: safeUptime(),
      platform: platform(),
      arch: arch()
    };
  }

  private async capture() {
    if (platform() === 'darwin') {
      try {
        const {stdout} = await run('sysctl', ['-n', 'kern.memorystatus_level'], {timeout: 2_000});
        this.availableBytes = availableMemoryFromStatusLevel(stdout, totalmem());
      } catch {
        this.availableBytes = undefined; // fall back to freemem() rather than lose the sample
      }
    }
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
