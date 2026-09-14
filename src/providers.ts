import type {ProviderId} from './daemon-protocol.js';
import {existsSync, readdirSync} from 'node:fs';
import {delimiter, dirname, isAbsolute, join} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {ProviderHealth} from './daemon-protocol.js';

const run = promisify(execFile);

export type ProviderAdapter = {
  id: ProviderId;
  label: string;
  executable: string;
  args: readonly string[];
  /** Native adapters launch their provider CLI. The model-link adapters launch OpenCode with an
   * account-scoped inline configuration, so OpenCode never needs to persist Fluent's API key. */
  runtime?: 'native' | 'opencode';
  defaultModel?: string;
  defaultBaseUrl?: string;
};

const adapters: Record<ProviderId, ProviderAdapter> = {
  claude: {id: 'claude', label: 'Claude Code', executable: 'claude', args: []},
  codex: {id: 'codex', label: 'Codex', executable: 'codex', args: []},
  gemini: {id: 'gemini', label: 'Gemini CLI', executable: 'gemini', args: []},
  // These providers expose OpenAI-compatible coding endpoints. OpenCode is the intentionally
  // narrow bridge: it is a real local terminal coding agent, not a Fluent-hosted proxy.
  qwen: {
    id: 'qwen', label: 'Qwen via OpenCode', executable: 'opencode', args: [], runtime: 'opencode',
    defaultModel: 'qwen3-coder', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  },
  glm: {
    id: 'glm', label: 'GLM via OpenCode', executable: 'opencode', args: [], runtime: 'opencode',
    defaultModel: 'GLM-4.7', defaultBaseUrl: 'https://api.z.ai/api/coding/paas/v4'
  },
  nvidia: {
    id: 'nvidia', label: 'NVIDIA NIM via OpenCode', executable: 'opencode', args: [], runtime: 'opencode',
    defaultModel: 'nvidia/nemotron-3-super', defaultBaseUrl: 'https://integrate.api.nvidia.com/v1'
  }
};

export function providerAdapter(provider: ProviderId) {
  return adapters[provider];
}

export function isOpenCodeAdapter(adapter: ProviderAdapter) {
  return adapter.runtime === 'opencode';
}

/** The model flag selects Fluent's isolated provider entry rather than a model remembered by a
 * user's unrelated OpenCode session. It is non-secret account metadata. */
export function providerLaunchArgs(provider: ProviderId, environment?: {set: Record<string, string>}) {
  const adapter = providerAdapter(provider);
  if (!isOpenCodeAdapter(adapter)) return [];
  const model = environment?.set.FLUENT_OPENCODE_MODEL;
  if (!model) throw new Error(`${adapter.label} needs a connected API-key account with a model selected.`);
  return ['--model', model];
}

export function resolveProviderExecutable(provider: ProviderAdapter): string {
  if (isAbsolute(provider.executable)) return provider.executable;
  const nvmBins = (() => {
    try {
      return readdirSync(join(homedir(), '.nvm', 'versions', 'node'))
        .sort()
        .reverse()
        .map(version => join(homedir(), '.nvm', 'versions', 'node', version, 'bin'));
    } catch {
      return [];
    }
  })();
  const directories = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'), ...nvmBins];
  for (const directory of directories) {
    const candidate = join(directory, provider.executable);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${provider.label} is not installed or is not available in fluentd's PATH`);
}

export async function providerHealth(): Promise<ProviderHealth[]> {
  return Promise.all(Object.values(adapters).map(async adapter => {
    try {
      const executable = resolveProviderExecutable(adapter);
      // npm-installed CLIs commonly have a `#!/usr/bin/env node` shebang. fluentd may have
      // found the executable through NVM even when its inherited PATH lacks that same Node bin.
      const env = {...process.env, PATH: [dirname(executable), process.env.PATH].filter(Boolean).join(delimiter)};
      const {stdout, stderr} = await run(executable, ['--version'], {timeout: 3_000, env});
      return {id: adapter.id, label: adapter.label, installed: true, executable, version: (stdout || stderr).trim().split(/\r?\n/)[0]};
    } catch {
      return {id: adapter.id, label: adapter.label, installed: false};
    }
  }));
}
