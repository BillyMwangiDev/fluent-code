#!/usr/bin/env node
import {daemonRequest} from './daemon-client.js';
import {parseLaneArguments} from './lane-commands.js';

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
 * Every command identifies its lane by the directory it runs in, plus the `FLUENT_SESSION_ID` the
 * lane was launched with — the directory alone cannot tell apart lanes sharing one checkout. An
 * agent never has to type a session id.
 */
const usage = `fluent-coord — coordination between agent lanes

  fluent-coord status [--since CURSOR]   everything at once: tasks, claims, conflicts, handoffs
  fluent-coord claim PATH...             say you intend to edit these paths, before you edit them
  fluent-coord release PATH...           give the paths back
  fluent-coord note SUMMARY...           record a decision other lanes should know about
  fluent-coord task add TITLE...         add a shared task
  fluent-coord task start ID             take a task
  fluent-coord task done ID              finish a task
  fluent-coord send LANE MESSAGE...      message another lane; it reads it when it next checks
  fluent-coord inbox                     read your unread messages, oldest first
  fluent-coord handoff LANE SUMMARY...   propose handing your work to another lane

Lead sessions only (the user started this lane as a lead):
  fluent-coord lane start PROVIDER [--shared] [--task ID] PROMPT...
                                         start a lane of your own
  fluent-coord lane list                 your lanes, and which of them need you
  fluent-coord lane assign LANE TASK     give one of your lanes a ticket from the board
  fluent-coord lane read LANE [--lines N]
                                         the end of that lane's terminal screen
  fluent-coord lane wait [LANE...] [--timeout SECONDS]
                                         return when a lane finishes, messages you, or stops
  fluent-coord lane stop LANE            stop one of your lanes

Lanes may be different products — a Codex lane and a Claude lane are peers here.
Run it from inside your working directory; that is how it knows which lane you are.
'status --since CURSOR' prints 'unchanged CURSOR' when nothing has changed since that check.
A refused claim is an ordinary result, not an error: read it and coordinate.`;

type Reply = {text: string};

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const lane = {cwd: process.cwd(), ...(process.env.FLUENT_SESSION_ID ? {sessionId: process.env.FLUENT_SESSION_ID} : {})};

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }

  switch (command) {
    case 'status': {
      const sinceFlag = rest.indexOf('--since');
      const since = sinceFlag >= 0 ? rest[sinceFlag + 1] : undefined;
      return print(await daemonRequest<Reply>('agent.status', {...lane, since}));
    }
    case 'claim':
      return print(await daemonRequest<Reply>('agent.claim', {...lane, paths: rest}));
    case 'release':
      return print(await daemonRequest<Reply>('agent.release', {...lane, paths: rest}));
    case 'note':
      return print(await daemonRequest<Reply>('agent.note', {...lane, summary: rest.join(' ')}));
    case 'task': {
      const [action, ...args] = rest;
      if (action !== 'add' && action !== 'start' && action !== 'done') throw new Error('usage: fluent-coord task add|start|done');
      return print(await daemonRequest<Reply>('agent.task', {...lane, action, title: args.join(' '), taskId: args[0]}));
    }
    case 'send': {
      const [to, ...body] = rest;
      if (!to || body.length === 0) throw new Error('usage: fluent-coord send LANE MESSAGE...');
      return print(await daemonRequest<Reply>('agent.send', {...lane, to, body: body.join(' ')}));
    }
    case 'inbox':
      return print(await daemonRequest<Reply>('agent.inbox', {...lane, peek: rest.includes('--peek')}));
    case 'handoff': {
      const [to, ...summary] = rest;
      if (!to) throw new Error('usage: fluent-coord handoff LANE SUMMARY...');
      return print(await daemonRequest<Reply>('agent.handoff', {...lane, to, summary: summary.join(' ')}));
    }
    case 'lane':
      return print(await daemonRequest<Reply>('agent.lane', {...lane, ...parseLaneArguments(rest)}));
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
