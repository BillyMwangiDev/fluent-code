import {spawn, type ChildProcessByStdio} from 'node:child_process';
import type {Readable, Writable} from 'node:stream';
import {existsSync} from 'node:fs';
import {arch, platform} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

/**
 * Mirrors the wire types `native/resource-monitor/src/main.rs` emits (forked from T3 Code,
 * MIT licensed — see that file's header). Field names are already camelCase because the Rust
 * side serializes with `#[serde(rename_all = "camelCase")]`.
 */
export type ProcessSample = {
  pid: number;
  ppid: number;
  startTimeMs: number;
  runTimeMs: number;
  name: string;
  command: string;
  status: string;
  cpuPercent: number;
  cpuTimeMs: number;
  residentBytes: number;
  virtualBytes: number;
  ioReadBytes: number;
  ioWriteBytes: number;
  ioSemantics: 'storage' | 'all-io';
};

export type ResourceSnapshot = {
  sequence: number;
  sampledAtUnixMs: number;
  scannedProcessCount: number;
  retainedProcessCount: number;
  inaccessibleProcessCount: number;
  processes: ProcessSample[];
};

type HelloEvent = {type: 'hello'; sidecarVersion: string; sidecarPid: number; platform: string; arch: string};
type SnapshotWire = Omit<ResourceSnapshot, never> & {type: 'snapshot'; requestId?: string};
type HistoryChunkWire = {type: 'historyChunk'; requestId: string; done: boolean; snapshots: SnapshotWire[]};
type ErrorWire = {type: 'error'; code: string; message: string; recoverable: boolean};
type ProcessTableWire = {type: 'processTable'; requestId: string; processes: Array<{pid: number; ppid: number; name: string}>};
type Wire = HelloEvent | SnapshotWire | HistoryChunkWire | ErrorWire | ProcessTableWire;

const PROTOCOL_VERSION = 3;

function binaryName(): string {
  return platform() === 'win32' ? 'fluent-resource-monitor.exe' : 'fluent-resource-monitor';
}

/** Dev-build candidate paths; a packaged app would bundle the binary and set
 * FLUENT_RESOURCE_MONITOR_PATH instead of relying on any of these. */
function candidatePaths(): string[] {
  const packageRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const name = binaryName();
  const overridePath = process.env.FLUENT_RESOURCE_MONITOR_PATH;
  const candidates = [
    join(packageRoot, 'native', 'resource-monitor', 'target', 'release', name),
    join(packageRoot, 'native', 'resource-monitor', 'target', 'debug', name)
  ];
  return overridePath ? [overridePath, ...candidates] : candidates;
}

export function resolveResourceMonitorBinary(): string | undefined {
  return candidatePaths().find(existsSync);
}

type Pending = {resolve: (value: unknown) => void; reject: (error: Error) => void; chunks?: SnapshotWire[]};

/**
 * Owns one `fluent-resource-monitor` child process for the lifetime of fluentd. A crash here
 * never takes fluentd down with it (spec §10's "advisory, not enforcement" applies to the
 * monitor's own reliability too) — callers get a rejected promise, not a dead daemon.
 */
export class ResourceMonitorClient {
  private child?: ChildProcessByStdio<Writable, Readable, null>;
  private buffer = '';
  private readonly pending = new Map<string, Pending>();
  private configured = false;
  private startError: string | undefined;

  start(rootPid: number, sampleIntervalMs = 3_000) {
    const binaryPath = resolveResourceMonitorBinary();
    if (!binaryPath) {
      this.startError = `fluent-resource-monitor binary not found for ${platform()}/${arch()} — run \`cargo build --release\` in native/resource-monitor`;
      return;
    }
    const child = spawn(binaryPath, [], {stdio: ['pipe', 'pipe', 'ignore']});
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.onData(chunk));
    child.on('exit', () => {
      this.child = undefined;
      this.configured = false;
      for (const pending of this.pending.values()) pending.reject(new Error('fluent-resource-monitor exited'));
      this.pending.clear();
    });
    this.write({type: 'configure', version: PROTOCOL_VERSION, rootPid, sampleIntervalMs, externalProcesses: []});
    this.configured = true;
  }

  stop() {
    if (this.child) this.write({type: 'shutdown', version: PROTOCOL_VERSION});
    this.child?.kill();
    this.child = undefined;
  }

  get available(): boolean {
    return this.configured;
  }

  get unavailableReason(): string | undefined {
    return this.startError;
  }

  async sampleNow(): Promise<ResourceSnapshot> {
    return this.request<ResourceSnapshot>({type: 'sampleNow', version: PROTOCOL_VERSION});
  }

  async readHistory(windowMs: number): Promise<ResourceSnapshot[]> {
    return this.request<ResourceSnapshot[]>({type: 'readHistory', version: PROTOCOL_VERSION, windowMs}, true);
  }

  private write(command: Record<string, unknown>) {
    this.child?.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private request<T>(command: Record<string, unknown>, isHistory = false): Promise<T> {
    if (!this.child) return Promise.reject(new Error(this.startError ?? 'fluent-resource-monitor is not running'));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {resolve: resolve as (value: unknown) => void, reject, chunks: isHistory ? [] : undefined});
      this.write({...command, requestId});
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let event: Wire;
      try {
        event = JSON.parse(line) as Wire;
      } catch {
        continue;
      }
      this.handleEvent(event);
    }
  }

  private handleEvent(event: Wire) {
    if (event.type === 'hello' || event.type === 'error') return;
    if (event.type === 'snapshot') {
      const {type: _type, requestId, ...snapshot} = event;
      if (!requestId) return; // an unrequested streaming sample; not used yet (streaming is off by default)
      const pending = this.pending.get(requestId);
      if (pending) {
        this.pending.delete(requestId);
        pending.resolve(snapshot);
      }
      return;
    }
    if (event.type === 'processTable') {
      const pending = this.pending.get(event.requestId);
      if (pending) {
        this.pending.delete(event.requestId);
        pending.resolve(event.processes);
      }
      return;
    }
    if (event.type === 'historyChunk') {
      const pending = this.pending.get(event.requestId);
      if (!pending) return;
      pending.chunks = [...(pending.chunks ?? []), ...event.snapshots];
      if (event.done) {
        this.pending.delete(event.requestId);
        pending.resolve(pending.chunks.map(({type: _type, requestId: _requestId, ...snapshot}) => snapshot));
      }
    }
  }
}
