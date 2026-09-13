#!/usr/bin/env node
import {daemonRequest} from './daemon-client.js';

/**
 * The coordination surface agents actually use.
 *
 * This is a CLI rather than an MCP server on purpose. Every coding agent already has a shell, so a
 * command works on every provider Fluent supports and every provider it might support later —
 * including ones with no MCP client at all — with no per-provider server config to install, no
 * server process per lane, and nothing to keep alive. It is also the same shape the prior art
 * settled on (herdr's agent-facing CLI and socket API), and the AXI principles spec §11 already
 * cites are specifically about CLI output written to be read by an agent.
 *
 * The cost, stated plainly: an MCP tool announces itself in the model's tool list, and a command
 * does not. So the lane has to be told this exists — see `coordinationBriefing` in providers.ts,
 * which passes it through each CLI's own convention for project direction (spec §7.5), never by
 * intercepting anything.
 *
 * Every command identifies its lane by the directory it runs in. An agent never sees a session id.
 */
const usage = `fluent-coord — coordination between agent lanes

  fluent-coord status [--since CURSOR]   everything at once: tasks, claims, conflicts, handoffs
  fluent-coord claim PATH...             say you intend to edit these paths, before you edit them
  fluent-coord release PATH...           give the paths back
  fluent-coord note SUMMARY...           record a decision other lanes should know about
  fluent-coord task add TITLE...         add a shared task
  fluent-coord task start ID             take a task
  fluent-coord task done ID              finish a task
  fluent-coord handoff LANE SUMMARY...   propose handing your work to another lane

Run it from inside your working directory; that is how it knows which lane you are.
'status --since CURSOR' prints 'unchanged CURSOR' when nothing has changed since that check.
A refused claim is an ordinary result, not an error: read it and coordinate.`;

type Reply = {text: string};

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const cwd = process.cwd();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }

  switch (command) {
    case 'status': {
      const sinceFlag = rest.indexOf('--since');
      const since = sinceFlag >= 0 ? rest[sinceFlag + 1] : undefined;
      return print(await daemonRequest<Reply>('agent.status', {cwd, since}));
    }
    case 'claim':
      return print(await daemonRequest<Reply>('agent.claim', {cwd, paths: rest}));
    case 'release':
      return print(await daemonRequest<Reply>('agent.release', {cwd, paths: rest}));
    case 'note':
      return print(await daemonRequest<Reply>('agent.note', {cwd, summary: rest.join(' ')}));
    case 'task': {
      const [action, ...args] = rest;
      if (action !== 'add' && action !== 'start' && action !== 'done') throw new Error('usage: fluent-coord task add|start|done');
      return print(await daemonRequest<Reply>('agent.task', {cwd, action, title: args.join(' '), taskId: args[0]}));
    }
    case 'handoff': {
      const [to, ...summary] = rest;
      if (!to) throw new Error('usage: fluent-coord handoff LANE SUMMARY...');
      return print(await daemonRequest<Reply>('agent.handoff', {cwd, to, summary: summary.join(' ')}));
    }
    default:
      throw new Error(`Unknown command ${command}\n\n${usage}`);
  }
}

function print(reply: Reply) {
  console.log(reply.text);
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  // Exit 1 means the command could not be carried out. A refused claim is *not* this: it is a
  // successful answer to a reasonable question, and an agent that treats it as a tool failure will
  // retry it instead of reading it.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
