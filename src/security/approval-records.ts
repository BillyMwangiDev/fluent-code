import {createHash, randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {dirname, isAbsolute, normalize, resolve} from 'node:path';
import {readPrivateJson, writePrivateJson} from './secure-state.js';

export type ApprovalAction =
  | 'credential.change'
  | 'worktree.remove'
  | 'worktree.reset'
  | 'worktree.rebase'
  | 'integration.merge'
  | 'session.delete'
  | 'remote.configure'
  | 'remote.connect'
  | 'extension.install'
  | 'extension.policy'
  | 'recipe.execute'
  | 'project.configure';

export type ApprovalRecord = {
  id: string;
  action: ApprovalAction;
  target: string;
  commandHash?: string;
  baseSha?: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
};

type StoredApprovals = {schemaVersion: 1; records: ApprovalRecord[]};

const minimumTtlMs = 1;
const maximumTtlMs = 10 * 60_000;

export function commandHash(command: string | undefined) {
  return command === undefined ? undefined : createHash('sha256').update(command).digest('hex');
}

/** Canonicalizes filesystem targets while retaining stable names for provider-owned identifiers. */
export async function canonicalApprovalTarget(target: string) {
  const trimmed = target.trim();
  if (!trimmed) throw new Error('An approval target is required');
  if (!isAbsolute(trimmed)) return `id:${trimmed.replace(/\s+/g, ' ')}`;
  const absolute = resolve(normalize(trimmed));
  try {
    return `path:${await realpath(absolute)}`;
  } catch {
    // A destructive action can target a path which does not exist yet. Canonicalize the nearest
    // existing parent so a later relative/symlink spelling cannot redeem this approval elsewhere.
    const parent = await realpath(dirname(absolute)).catch(() => undefined);
    if (!parent) throw new Error(`Approval target parent is unavailable: ${absolute}`);
    return `path:${resolve(parent, absolute.slice(dirname(absolute).length + 1))}`;
  }
}

export class ApprovalRecords {
  private readonly stateFile: string;
  private records = new Map<string, ApprovalRecord>();

  constructor(stateDirectory: string) {
    this.stateFile = resolve(stateDirectory, 'approval-records.json');
  }

  async restore() {
    const stored = await readPrivateJson<StoredApprovals>(this.stateFile);
    if (!stored || stored.schemaVersion !== 1) return;
    for (const record of stored.records) this.records.set(record.id, record);
    await this.removeExpired();
  }

  async issue(input: {action: ApprovalAction; target: string; command?: string; baseSha?: string; ttlMs?: number}) {
    const ttlMs = Math.max(minimumTtlMs, Math.min(input.ttlMs ?? 60_000, maximumTtlMs));
    const issuedAt = new Date();
    const record: ApprovalRecord = {
      id: randomUUID(),
      action: input.action,
      target: await canonicalApprovalTarget(input.target),
      commandHash: commandHash(input.command),
      baseSha: input.baseSha,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString()
    };
    this.records.set(record.id, record);
    await this.persist();
    return record;
  }

  /** Atomically consumes a single approval record after proving its complete action binding. */
  async consume(input: {id?: string; action: ApprovalAction; target: string; command?: string; baseSha?: string}) {
    if (!input.id) throw new Error(`Approval is required for ${input.action}`);
    const record = this.records.get(input.id);
    if (!record) throw new Error('Approval record was not found');
    if (record.consumedAt) throw new Error('Approval record has already been used');
    if (Date.parse(record.expiresAt) <= Date.now()) {
      await this.removeExpired();
      throw new Error('Approval record has expired');
    }
    const target = await canonicalApprovalTarget(input.target);
    if (record.action !== input.action || record.target !== target || record.commandHash !== commandHash(input.command) || record.baseSha !== input.baseSha) {
      throw new Error('Approval record does not authorize this action');
    }
    record.consumedAt = new Date().toISOString();
    await this.persist();
    return record;
  }

  private async removeExpired() {
    const now = Date.now();
    let changed = false;
    for (const [id, record] of this.records) {
      // Retain consumed records briefly as an audit receipt, but never leave a usable approval.
      if (Date.parse(record.expiresAt) <= now || (record.consumedAt && now - Date.parse(record.consumedAt) > 24 * 60 * 60_000)) {
        this.records.delete(id);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private async persist() {
    await writePrivateJson(this.stateFile, {schemaVersion: 1, records: [...this.records.values()]} satisfies StoredApprovals);
  }
}
