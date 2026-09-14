import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {RecipeRunner} from './recipe-runner.js';

const directories: string[] = [];
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'fluent-recipes-'));
  directories.push(directory);
  return directory;
}
async function manifest(directory: string, recipes: unknown) {
  await writeFile(join(directory, 'fluent.recipe.json'), JSON.stringify({schemaVersion: 1, recipes}));
}
after(async () => { for (const directory of directories) await rm(directory, {recursive: true, force: true}); });

describe('reviewed project recipes', () => {
  it('reads a bounded manifest and records a redacted execution receipt', async () => {
    const directory = await workspace();
    const state = await workspace();
    await manifest(directory, {check: {description: 'project check', command: 'printf "token=sk-test-should-not-survive\\n"', timeoutMs: 1_000}});
    const runner = new RecipeRunner(state);

    const recipe = await runner.recipe(directory, 'check');
    assert.equal(recipe.timeoutMs, 1_000);
    const receipt = await runner.execute(directory, recipe);
    assert.equal(receipt.status, 'passed');
    assert.match(receipt.output, /REDACTED/);
    assert.doesNotMatch(receipt.output, /sk-test-should-not-survive/);
    assert.equal(runner.listReceipts(directory)[0]?.id, receipt.id);

    const stored = await readFile(join(state, 'recipe-receipts.json'), 'utf8');
    assert.doesNotMatch(stored, /sk-test-should-not-survive/);
    const restored = new RecipeRunner(state);
    await restored.restore();
    assert.equal(restored.listReceipts(directory)[0]?.commandHash, receipt.commandHash);
  });

  it('rejects unsafe manifest shapes rather than turning them into shell input', async () => {
    const directory = await workspace();
    const runner = new RecipeRunner(await workspace());
    await manifest(directory, {'bad name': {command: 'true'}});
    await assert.rejects(() => runner.list(directory), /recipe name/);
    await manifest(directory, {bad: {command: ''}});
    await assert.rejects(() => runner.list(directory), /non-empty command/);
    await manifest(directory, {bad: {command: 'true', timeoutMs: 999}});
    await assert.rejects(() => runner.list(directory), /timeoutMs/);
  });

  it('captures a failed command and its actual exit status without treating it as a pass', async () => {
    const directory = await workspace();
    await manifest(directory, {fail: {command: 'printf bad >&2; exit 7'}});
    const runner = new RecipeRunner(await workspace());
    const receipt = await runner.execute(directory, await runner.recipe(directory, 'fail'));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.exitCode, 7);
    assert.match(receipt.output, /bad/);
  });
});
