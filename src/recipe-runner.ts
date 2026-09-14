import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {redact} from './perf/redaction.js';
import {readPrivateJson, writePrivateJson} from './security/secure-state.js';

const run = promisify(execFile);
const manifestName = 'fluent.recipe.json';
const outputLimit = 24_000;
const maxRecipes = 100;
const maxTimeoutMs = 30 * 60_000;
const defaultTimeoutMs = 10 * 60_000;
const receiptLimit = 300;

export type RecipeDefinition = {name: string; description?: string; command: string; timeoutMs: number};
export type RecipeReceipt = {
  id: string;
  directory: string;
  name: string;
  commandHash: string;
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed';
  exitCode: number | null;
  output: string;
};

type RecipeManifest = {schemaVersion: 1; recipes: Record<string, {description?: unknown; command?: unknown; timeoutMs?: unknown}>};
type StoredReceipts = {schemaVersion: 1; receipts: RecipeReceipt[]};

function recipeError(message: string) { return new Error(`Invalid ${manifestName}: ${message}`); }

function plainText(value: unknown, limit: number) {
  return typeof value === 'string' && value.trim() && value.length <= limit && !/[\u0000]/.test(value) ? value.trim() : undefined;
}

function receiptOutput(value: string) {
  const safe = redact(value);
  return (typeof safe === 'string' ? safe : String(safe)).slice(-outputLimit);
}

function restoredReceipt(value: unknown): RecipeReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw.status === 'passed' || raw.status === 'failed' ? raw.status : undefined;
  if (!status || typeof raw.id !== 'string' || typeof raw.directory !== 'string' || typeof raw.name !== 'string' || typeof raw.commandHash !== 'string'
    || typeof raw.startedAt !== 'string' || !Number.isFinite(Date.parse(raw.startedAt)) || typeof raw.durationMs !== 'number'
    || (raw.exitCode !== null && typeof raw.exitCode !== 'number') || typeof raw.output !== 'string') return undefined;
  return {id: raw.id, directory: raw.directory, name: raw.name, commandHash: raw.commandHash, startedAt: raw.startedAt, durationMs: raw.durationMs, status, exitCode: raw.exitCode, output: raw.output.slice(-outputLimit)};
}

/**
 * Reads only a repository-root `fluent.recipe.json`; it never scans or executes a recipe merely
 * because the file exists. The daemon resolves the requested name again immediately before
 * execution, and binds its exact command to a one-time approval record.
 */
export class RecipeRunner {
  private readonly stateFile: string;
  private receipts: RecipeReceipt[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    this.stateFile = join(stateDirectory, 'recipe-receipts.json');
  }

  async restore() {
    const stored = await readPrivateJson<StoredReceipts>(this.stateFile);
    if (!stored || stored.schemaVersion !== 1) return;
    this.receipts = Array.isArray(stored.receipts) ? stored.receipts.map(restoredReceipt).filter((receipt): receipt is RecipeReceipt => Boolean(receipt)).slice(-receiptLimit) : [];
  }

  async list(directory: string): Promise<RecipeDefinition[]> {
    const absolute = resolve(directory);
    const raw = await readFile(join(absolute, manifestName), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (raw === undefined) return [];
    let parsed: RecipeManifest;
    try { parsed = JSON.parse(raw) as RecipeManifest; } catch { throw recipeError('must be valid JSON'); }
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.recipes || typeof parsed.recipes !== 'object' || Array.isArray(parsed.recipes)) throw recipeError('expected {"schemaVersion": 1, "recipes": {...}}');
    const entries = Object.entries(parsed.recipes);
    if (entries.length > maxRecipes) throw recipeError(`at most ${maxRecipes} recipes are allowed`);
    return entries.map(([name, entry]) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name)) throw recipeError(`recipe name “${name}” must contain only letters, numbers, dot, underscore, or hyphen`);
      if (!entry || typeof entry !== 'object') throw recipeError(`recipe “${name}” must be an object`);
      const command = plainText(entry.command, 12_000);
      if (!command) throw recipeError(`recipe “${name}” needs a non-empty command no longer than 12000 characters`);
      const description = entry.description === undefined ? undefined : plainText(entry.description, 1_000);
      if (entry.description !== undefined && !description) throw recipeError(`recipe “${name}” description must be plain text no longer than 1000 characters`);
      const timeoutMs = entry.timeoutMs === undefined ? defaultTimeoutMs : entry.timeoutMs;
      if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > maxTimeoutMs) {
        throw recipeError(`recipe “${name}” timeoutMs must be an integer between 1000 and ${maxTimeoutMs}`);
      }
      return {name, ...(description ? {description} : {}), command, timeoutMs};
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  async recipe(directory: string, name: string) {
    const recipe = (await this.list(directory)).find(candidate => candidate.name === name);
    if (!recipe) throw new Error(`Recipe not found: ${name}`);
    return recipe;
  }

  listReceipts(directory?: string) {
    const absolute = directory ? resolve(directory) : undefined;
    return this.receipts.filter(receipt => !absolute || receipt.directory === absolute).map(receipt => ({...receipt}));
  }

  async execute(directory: string, recipe: RecipeDefinition): Promise<RecipeReceipt> {
    const absolute = resolve(directory);
    const startedAt = new Date().toISOString();
    const began = Date.now();
    let status: RecipeReceipt['status'] = 'passed';
    let exitCode: number | null = 0;
    let output = '';
    try {
      const result = await run('sh', ['-c', recipe.command], {cwd: absolute, timeout: recipe.timeoutMs, maxBuffer: 4_000_000});
      output = `${result.stdout}${result.stderr}`;
    } catch (error) {
      const failure = error as {stdout?: string; stderr?: string; code?: number | string; killed?: boolean; message?: string};
      status = 'failed';
      exitCode = typeof failure.code === 'number' ? failure.code : null;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}` || failure.message || 'recipe produced no output';
      if (failure.killed) output += `\n\nfluentd stopped this recipe after ${recipe.timeoutMs}ms.`;
    }
    const receipt: RecipeReceipt = {
      id: randomUUID(), directory: absolute, name: recipe.name,
      commandHash: createHash('sha256').update(recipe.command).digest('hex'),
      startedAt, durationMs: Date.now() - began, status, exitCode, output: receiptOutput(output)
    };
    this.receipts = [...this.receipts, receipt].slice(-receiptLimit);
    await this.persist();
    return receipt;
  }

  private async persist() {
    const operation = this.queue.then(() => writePrivateJson(this.stateFile, {schemaVersion: 1, receipts: this.receipts} satisfies StoredReceipts));
    this.queue = operation.catch(() => undefined);
    await operation;
  }
}
