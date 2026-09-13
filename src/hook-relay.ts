#!/usr/bin/env node
import {connect} from 'node:net';
import {randomUUID} from 'node:crypto';
import {daemonSocketPath} from './daemon-protocol.js';

/**
 * Invoked directly by Claude Code's own hooks config (never by Fluent parsing terminal output —
 * spec §7.5). Reads the hook's JSON payload from stdin, forwards it to fluentd as `hooks.report`,
 * and always exits 0: a hook script must never block or fail the CLI turn it's reporting on,
 * with or without fluentd running.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const eventName = process.argv[2] ?? 'Unknown';
  const raw = await readStdin();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    payload = {raw};
  }
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();

  if (eventName === 'StatusLine') {
    const context = payload.context_window as Record<string, unknown> | undefined;
    const model = payload.model as Record<string, unknown> | undefined;
    const percent = typeof context?.used_percentage === 'number' ? `${Math.round(context.used_percentage)}% ctx` : 'ctx —';
    process.stdout.write(`fluent · ${typeof model?.display_name === 'string' ? model.display_name : 'claude'} · ${percent}\n`);
  }

  await new Promise<void>(resolve => {
    const socket = connect(daemonSocketPath());
    const finish = () => {
      socket.destroy();
      resolve();
    };
    socket.once('error', finish);
    socket.once('timeout', finish);
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({id: randomUUID(), method: 'hooks.report', params: {cwd, event: eventName, payload}})}\n`);
    });
    socket.once('data', finish);
  });
}

void main().finally(() => process.exit(0));
