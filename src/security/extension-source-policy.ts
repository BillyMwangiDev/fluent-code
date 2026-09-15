import {resolve} from 'node:path';
import {readPrivateJson, writePrivateJson} from './secure-state.js';

export type ExtensionSourcePolicyMode = 'review-each' | 'trusted-only';
export type TrustedExtensionSource = {
  /** Stable, canonical identity. It is never a raw URL containing credentials or query data. */
  id: string;
  kind: 'marketplace' | 'mcp';
  /** Human-readable, already-redacted description of the source boundary. */
  source: string;
  addedAt: string;
};
export type ExtensionSourcePolicyState = {
  mode: ExtensionSourcePolicyMode;
  sources: TrustedExtensionSource[];
};

type StoredExtensionSourcePolicy = {schemaVersion: 1; mode: ExtensionSourcePolicyMode; sources: TrustedExtensionSource[]};

function validSource(value: unknown): value is TrustedExtensionSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return typeof source.id === 'string' && source.id.length > 0 && source.id.length <= 1_000
    && (source.kind === 'marketplace' || source.kind === 'mcp')
    && typeof source.source === 'string' && source.source.length > 0 && source.source.length <= 4_000
    && typeof source.addedAt === 'string' && Number.isFinite(Date.parse(source.addedAt));
}

/**
 * A local owner-controlled source policy. It grants no provider permission by itself: every
 * installation still consumes its own short-lived approval record. In trusted-only mode the
 * policy adds a second, durable boundary before an extension's code or endpoint can be registered.
 */
export class ExtensionSourcePolicy {
  private readonly stateFile: string;
  private state: ExtensionSourcePolicyState = {mode: 'review-each', sources: []};

  constructor(stateDirectory: string) {
    this.stateFile = resolve(stateDirectory, 'extension-source-policy.json');
  }

  async restore() {
    const stored = await readPrivateJson<StoredExtensionSourcePolicy>(this.stateFile);
    if (!stored || stored.schemaVersion !== 1) return this.get();
    const mode = stored.mode === 'trusted-only' ? 'trusted-only' : 'review-each';
    const sources = Array.isArray(stored.sources)
      ? stored.sources.filter(validSource).filter((source, index, entries) => entries.findIndex(candidate => candidate.id === source.id) === index)
      : [];
    this.state = {mode, sources};
    if (mode !== stored.mode || sources.length !== (stored.sources?.length ?? 0)) await this.persist();
    return this.get();
  }

  get(): ExtensionSourcePolicyState {
    return {mode: this.state.mode, sources: this.state.sources.map(source => ({...source}))};
  }

  allows(source: Pick<TrustedExtensionSource, 'id'>) {
    return this.state.mode === 'review-each' || this.state.sources.some(candidate => candidate.id === source.id);
  }

  async setMode(mode: ExtensionSourcePolicyMode) {
    if (mode !== 'review-each' && mode !== 'trusted-only') throw new Error('Extension source policy mode must be review-each or trusted-only');
    this.state = {...this.state, mode};
    await this.persist();
    return this.get();
  }

  async trust(source: Omit<TrustedExtensionSource, 'addedAt'>) {
    if (!validSource({...source, addedAt: new Date().toISOString()})) throw new Error('Extension source policy entry is invalid');
    if (this.state.sources.some(candidate => candidate.id === source.id)) return this.get();
    this.state = {...this.state, sources: [...this.state.sources, {...source, addedAt: new Date().toISOString()}]};
    await this.persist();
    return this.get();
  }

  async remove(id: string) {
    if (typeof id !== 'string' || !id || id.length > 1_000) throw new Error('Extension source policy entry is invalid');
    const sources = this.state.sources.filter(source => source.id !== id);
    if (sources.length === this.state.sources.length) throw new Error('Trusted extension source was not found');
    this.state = {...this.state, sources};
    await this.persist();
    return this.get();
  }

  private async persist() {
    await writePrivateJson(this.stateFile, {schemaVersion: 1, ...this.state} satisfies StoredExtensionSourcePolicy);
  }
}
