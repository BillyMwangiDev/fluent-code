import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {connect} from 'node:net';
import {fluentProtocolVersion, type RemoteProfile} from './daemon-protocol.js';
import {readPrivateJson, writePrivateJson} from './security/secure-state.js';

type RemoteProfileInput = {name: string; host: string; port?: number; remoteSocket?: string; autoReconnect?: boolean};
type StoredRemoteProfile = Partial<RemoteProfile> & {id?: unknown};
const reconnectDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

const safeName = /^[^\u0000-\u001F\u007F]{1,80}$/;
const safeUser = /^[A-Za-z0-9._-]{1,64}$/;
const safeHost = /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*|\[[0-9A-Fa-f:.%]+\])$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function localSocketPath(id: string) {
  return `/tmp/fluent-remote-${id}.sock`;
}

/** Validates the small subset of SSH destination syntax Fluent deliberately supports. Passing
 * opaque strings through to ssh makes saved remote profiles an option-injection and ambiguity
 * surface, even though spawn itself never invokes a shell. */
export function normalizeRemoteProfileInput(input: RemoteProfileInput) {
  const name = input.name.trim();
  if (!safeName.test(name)) throw new Error('Remote name must be 1–80 printable characters');

  const host = input.host.trim();
  if (host !== input.host || host.startsWith('-') || /[\s\u0000-\u001F\u007F]/.test(host)) {
    throw new Error('Remote host must not contain whitespace, control characters, or SSH options');
  }
  const parts = host.split('@');
  const hostname = parts.length === 2 ? parts[1] : parts.length === 1 ? parts[0] : undefined;
  const username = parts.length === 2 ? parts[0] : undefined;
  if (!hostname || !safeHost.test(hostname) || (username !== undefined && !safeUser.test(username))) {
    throw new Error('Remote host must be host, user@host, or a bracketed IPv6 address');
  }

  const port = input.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Remote SSH port must be an integer from 1 to 65535');

  const remoteSocket = (input.remoteSocket ?? '/tmp/fluent-code.sock').trim();
  if (!isAbsolute(remoteSocket) || remoteSocket.includes(':') || /[\u0000\r\n]/.test(remoteSocket)) {
    throw new Error('Remote daemon socket must be an absolute Unix-socket path without colons or control characters');
  }
  return {name, host, port, remoteSocket, autoReconnect: input.autoReconnect === true};
}

function restoreProfile(input: StoredRemoteProfile): RemoteProfile | undefined {
  if (typeof input.id !== 'string' || !uuid.test(input.id)) return undefined;
  if (typeof input.name !== 'string' || typeof input.host !== 'string') return undefined;
  try {
    const normalized = normalizeRemoteProfileInput({
      name: input.name,
      host: input.host,
      port: input.port,
      remoteSocket: input.remoteSocket,
      autoReconnect: input.autoReconnect
    });
    return {
      id: input.id,
      ...normalized,
      // Never trust a persisted local endpoint: it is an ephemeral, Fluent-owned tunnel path.
      localSocket: localSocketPath(input.id),
      autoReconnect: normalized.autoReconnect,
      status: 'disconnected'
    };
  } catch {
    return undefined;
  }
}

export class RemoteManager {
  private profiles: RemoteProfile[] = [];
  private readonly processes = new Map<string, ChildProcess>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly stateFile: string;
  private persistQueue: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(
    stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent'),
    private readonly options: {sshExecutable?: string; sshEnvironment?: NodeJS.ProcessEnv} = {}
  ) {
    this.stateFile = join(stateDirectory, 'remotes.json');
  }
  async restore() {
    try {
      const stored = await readPrivateJson<StoredRemoteProfile[]>(this.stateFile) ?? [];
      this.profiles = stored.flatMap(profile => {
        const restored = restoreProfile(profile);
        return restored ? [restored] : [];
      });
    }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  list() { return this.profiles.map(profile => ({...profile})); }
  async save(input: RemoteProfileInput) {
    const {name, host, port, remoteSocket, autoReconnect} = normalizeRemoteProfileInput(input);
    const id = randomUUID();
    const profile: RemoteProfile = {id, name, host, port, remoteSocket, localSocket: localSocketPath(id), autoReconnect, status: 'disconnected'};
    this.profiles.push(profile); await this.persist(); return profile;
  }
  async connect(profileId: string) {
    this.cancelReconnect(profileId);
    this.reconnectAttempts.delete(profileId);
    return this.connectNow(profileId);
  }
  private async connectNow(profileId: string) {
    const profile = this.require(profileId);
    if (this.processes.has(profileId)) return profile;
    await this.removeStaleSocket(profile.localSocket);
    profile.status = 'connecting'; profile.error = undefined;
    const child = spawn(this.options.sshExecutable ?? 'ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-p', String(profile.port), '-L', `${profile.localSocket}:${profile.remoteSocket}`, '--', profile.host], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: this.options.sshEnvironment ?? process.env
    });
    this.processes.set(profileId, child);
    let error = '';
    child.stderr?.on('data', chunk => { error += chunk.toString(); });
    child.once('spawn', () => {
      void this.probe(profile.localSocket).then(result => {
        if (this.processes.get(profileId) !== child) return;
        if (result.ok) {
          profile.status = 'connected';
          profile.error = undefined;
          this.reconnectAttempts.delete(profileId);
        } else {
          profile.status = 'failed';
          profile.error = result.error;
          child.kill('SIGTERM');
        }
        void this.persist();
      });
    });
    let terminated = false;
    const terminatedUnexpectedly = (message: string) => {
      if (terminated) return;
      terminated = true;
      this.processes.delete(profileId);
      if (profile.status !== 'disconnected' && profile.status !== 'failed') {
        profile.status = 'disconnected';
        profile.error = message;
        this.scheduleReconnect(profile);
      }
      void this.persist();
    };
    child.once('error', event => terminatedUnexpectedly(event.message));
    child.once('exit', code => terminatedUnexpectedly(error.trim() || `ssh exited ${code ?? 'unexpectedly'}`));
    await this.persist(); return profile;
  }
  async disconnect(profileId: string) {
    const profile = this.require(profileId);
    this.cancelReconnect(profileId);
    this.reconnectAttempts.delete(profileId);
    const child = this.processes.get(profileId);
    // Set this first: the exit observer then records the same intentional state rather than
    // converting a user-requested disconnect into a spurious tunnel failure.
    profile.status = 'disconnected'; profile.error = undefined;
    this.processes.delete(profileId);
    if (child) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await this.waitForChild(exited, 1_000);
    }
    await this.removeStaleSocket(profile.localSocket).catch(() => undefined);
    await this.persist(); return profile;
  }
  /** A local daemon owns its SSH child processes. Leaving a forward behind after it exits would
   * leave an opaque privileged endpoint running with no Fluent UI able to name or close it. */
  async shutdown() {
    this.shuttingDown = true;
    for (const id of this.reconnectTimers.keys()) this.cancelReconnect(id);
    await Promise.all(this.profiles.map(profile => this.disconnect(profile.id).catch(() => undefined)));
  }
  private require(id: string) { const profile = this.profiles.find(item => item.id === id); if (!profile) throw new Error('Remote profile not found'); return profile; }
  private async probe(socketPath: string) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await new Promise<{ok: true} | {ok: false; error: string; retry: boolean}>(resolve => {
        const socket = connect(socketPath);
        let buffer = '';
        const timer = setTimeout(() => { socket.destroy(); resolve({ok: false, error: 'SSH tunnel did not receive a Fluent daemon handshake.', retry: true}); }, 500);
        socket.once('connect', () => socket.write(`${JSON.stringify({id: 'fluent-remote-probe', method: 'ping'})}\n`));
        socket.once('error', () => { clearTimeout(timer); resolve({ok: false, error: 'SSH tunnel could not connect to the remote Fluent daemon socket.', retry: true}); });
        socket.on('data', chunk => {
          buffer += chunk.toString();
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          clearTimeout(timer);
          socket.end();
          try {
            const response = JSON.parse(buffer.slice(0, newline)) as {ok?: boolean; result?: {protocolVersion?: number}};
            if (response.ok && response.result?.protocolVersion === fluentProtocolVersion) resolve({ok: true});
            else resolve({ok: false, error: `Remote Fluent daemon protocol is incompatible (expected v${fluentProtocolVersion}).`, retry: false});
          } catch {
            resolve({ok: false, error: 'SSH tunnel reached a socket that is not a Fluent daemon.', retry: false});
          }
        });
      });
      if (result.ok) return result;
      if (!result.retry) return result;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return {ok: false as const, error: 'SSH tunnel started, but remote fluentd did not return a compatible handshake.'};
  }
  private async removeStaleSocket(socketPath: string) {
    try {
      const entry = await lstat(socketPath);
      if (!entry.isSocket()) throw new Error(`Refusing to remove non-socket remote endpoint: ${socketPath}`);
      await unlink(socketPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  /** Reconnection is opt-in at profile creation, bounded, and cancelled by a direct disconnect.
   * It re-establishes only the already-approved SSH forwarding configuration; it never changes
   * credentials, daemon settings, or the desktop's currently selected remote target. */
  private scheduleReconnect(profile: RemoteProfile) {
    if (!profile.autoReconnect || this.shuttingDown || this.reconnectTimers.has(profile.id)) return;
    const attempt = this.reconnectAttempts.get(profile.id) ?? 0;
    if (attempt >= reconnectDelaysMs.length) {
      profile.status = 'failed';
      profile.error = `SSH tunnel disconnected; automatic reconnect stopped after ${attempt} attempts.`;
      void this.persist();
      return;
    }
    const delay = reconnectDelaysMs[attempt]!;
    this.reconnectAttempts.set(profile.id, attempt + 1);
    profile.status = 'reconnecting';
    profile.error = `SSH tunnel disconnected; retrying in ${Math.round(delay / 1_000)}s (${attempt + 1}/${reconnectDelaysMs.length}).`;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(profile.id);
      if (this.shuttingDown || !profile.autoReconnect || profile.status !== 'reconnecting') return;
      void this.connectNow(profile.id).catch(error => {
        // A spawn failure may not emit a child error. Treat it like any other transient forward
        // failure rather than leaving the profile indefinitely marked reconnecting.
        profile.status = 'disconnected';
        profile.error = error instanceof Error ? error.message : String(error);
        this.scheduleReconnect(profile);
        void this.persist();
      });
    }, delay);
    timer.unref();
    this.reconnectTimers.set(profile.id, timer);
    void this.persist();
  }
  private cancelReconnect(profileId: string) {
    const timer = this.reconnectTimers.get(profileId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(profileId);
  }
  private async waitForChild(exited: Promise<void>, timeoutMs: number) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      exited,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      })
    ]);
    if (timer) clearTimeout(timer);
  }
  private async persist() {
    const operation = this.persistQueue.then(() => writePrivateJson(this.stateFile, this.profiles));
    this.persistQueue = operation.catch(() => undefined);
    await operation;
  }
}
