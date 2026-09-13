import {execFile} from 'node:child_process';
import {hostname, release} from 'node:os';
import {promisify} from 'node:util';
import {providerHealth} from './providers.js';
import type {SoftwareSnapshot} from './daemon-protocol.js';

const run = promisify(execFile);

/** Small, local-only service inventory. It intentionally reports facts fluentd can verify rather
 * than guessing about Docker, GPUs, ports, or deployment state that may not exist. */
export class SoftwareMonitor {
  async snapshot(): Promise<SoftwareSnapshot> {
    const [providers, git] = await Promise.all([
      providerHealth(),
      run('git', ['status', '--short', '--branch'], {cwd: process.cwd(), timeout: 2_000})
        .then(result => result.stdout.trim())
        .catch(() => undefined)
    ]);
    return {
      capturedAt: new Date().toISOString(),
      hostname: hostname(),
      kernel: release(),
      nodeVersion: process.version,
      daemonPid: process.pid,
      git,
      providers
    };
  }
}
