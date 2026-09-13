import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {connect} from 'node:net';
import type {RemoteProfile} from './daemon-protocol.js';

export class RemoteManager {
  private profiles: RemoteProfile[] = [];
  private readonly processes = new Map<string, ChildProcess>();
  private readonly stateFile: string;

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    this.stateFile = join(stateDirectory, 'remotes.json');
  }
  async restore() {
    try { this.profiles = JSON.parse(await readFile(this.stateFile, 'utf8')) as RemoteProfile[]; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.profiles = this.profiles.map(profile => ({...profile, status: 'disconnected', error: undefined}));
  }
  list() { return this.profiles; }
  async save({name, host, port = 22, remoteSocket = '/tmp/fluent-code.sock'}: {name: string; host: string; port?: number; remoteSocket?: string}) {
    const id = randomUUID();
    const profile: RemoteProfile = {id, name, host, port, remoteSocket, localSocket: `/tmp/fluent-remote-${id}.sock`, status: 'disconnected'};
    this.profiles.push(profile); await this.persist(); return profile;
  }
  async connect(profileId: string) {
    const profile = this.require(profileId);
    if (this.processes.has(profileId)) return profile;
    if (existsSync(profile.localSocket)) await unlink(profile.localSocket);
    profile.status = 'connecting'; profile.error = undefined;
    const child = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-p', String(profile.port), '-L', `${profile.localSocket}:${profile.remoteSocket}`, profile.host], {stdio: ['ignore', 'ignore', 'pipe']});
    this.processes.set(profileId, child);
    let error = '';
    child.stderr?.on('data', chunk => { error += chunk.toString(); });
    child.once('spawn', () => {
      void this.probe(profile.localSocket).then(ready => {
        if (ready && this.processes.get(profileId) === child) {
          profile.status = 'connected';
        } else if (this.processes.get(profileId) === child) {
          profile.status = 'failed';
          profile.error = 'SSH tunnel started, but remote fluentd did not accept a socket connection.';
          child.kill('SIGTERM');
        }
        void this.persist();
      });
    });
    child.once('error', event => { profile.status = 'failed'; profile.error = event.message; this.processes.delete(profileId); void this.persist(); });
    child.once('exit', code => {
      if (profile.status !== 'disconnected') { profile.status = 'failed'; profile.error = error.trim() || `ssh exited ${code ?? 'unexpectedly'}`; }
      this.processes.delete(profileId); void this.persist();
    });
    await this.persist(); return profile;
  }
  async disconnect(profileId: string) {
    const profile = this.require(profileId);
    this.processes.get(profileId)?.kill('SIGTERM'); this.processes.delete(profileId);
    if (existsSync(profile.localSocket)) await unlink(profile.localSocket).catch(() => undefined);
    profile.status = 'disconnected'; profile.error = undefined; await this.persist(); return profile;
  }
  private require(id: string) { const profile = this.profiles.find(item => item.id === id); if (!profile) throw new Error('Remote profile not found'); return profile; }
  private async probe(socketPath: string) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const connected = await new Promise<boolean>(resolve => {
        const socket = connect(socketPath);
        const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 300);
        socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve(true); });
        socket.once('error', () => { clearTimeout(timer); resolve(false); });
      });
      if (connected) return true;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
  }
  private async persist() {
    await mkdir(dirname(this.stateFile), {recursive: true});
    const temporary = `${this.stateFile}.tmp`; await writeFile(temporary, JSON.stringify(this.profiles, null, 2)); await rename(temporary, this.stateFile);
  }
}
