import test from 'node:test';
import assert from 'node:assert/strict';
import {ticketBlockers, ticketPrompt} from './coordination-prompts';
import type {Ticket} from './coordination-prompts';

const now = '2026-09-16T00:00:00.000Z';
const tasks: Ticket[] = [
  {id: 'a', title: 'Write the migration', status: 'done', createdAt: now},
  {id: 'b', title: 'Wire the endpoint', status: 'todo', role: 'backend', description: 'POST /accounts', dependsOn: ['a', 'zzz'], createdAt: now}
];

test('ticket prompt carries the brief once, the ticket, its prerequisites, and the report-back contract', () => {
  const prompt = ticketPrompt(tasks[1]!, {masterBrief: 'Ship accounts.', tasks});
  assert.match(prompt, /^Ticket: Wire the endpoint\nYou are the backend specialist/);
  assert.match(prompt, /Project direction:\nShip accounts\./);
  assert.match(prompt, /Assigned ticket: Wire the endpoint/);
  assert.match(prompt, /Ticket details:\nPOST \/accounts/);
  assert.match(prompt, /Prerequisites: Write the migration \(done\), zzz \(missing\)/);
  assert.match(prompt, /run the relevant checks/);
});

test('ticket prompt without a brief tells the lane to inspect the repository', () => {
  const prompt = ticketPrompt(tasks[0]!, {masterBrief: undefined, tasks});
  assert.match(prompt, /implementation specialist/);
  assert.match(prompt, /No master brief has been set/);
});

test('blockers are prerequisites that are missing or not done', () => {
  const blockers = ticketBlockers(tasks[1]!, tasks);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0], undefined);
  assert.deepEqual(ticketBlockers(tasks[0]!, tasks), []);
});
