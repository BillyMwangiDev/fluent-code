#!/usr/bin/env node
import {createInterface} from 'node:readline';
import type {Readable, Writable} from 'node:stream';
import {daemonRequest} from './daemon-client.js';

/**
 * One small MCP surface for the state agents need to share. Keeping this as one tool prevents a
 * per-lane tool catalogue from consuming context on every provider turn; the larger collaboration
 * skill remains progressive disclosure and the plain `fluent-coord` command remains the fallback
 * for agents that do not host MCP.
 */
export const fluentCoordTool = {
  name: 'fluent_coord',
  title: 'Fluent Code coordination',
  description: 'Read or update the shared Fluent Code task board, file claims, decisions, handoffs, and mailbox for this agent lane. Use status before editing and claim paths before modifying them. A lead session can also start and direct its own lanes with action lane.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {type: 'string', enum: ['status', 'claim', 'release', 'note', 'task', 'send', 'inbox', 'handoff', 'lane']},
      since: {type: 'string', description: 'Cursor returned by a prior status call.'},
      paths: {type: 'array', items: {type: 'string'}, description: 'Repository-relative paths for claim or release.'},
      summary: {type: 'string', description: 'Decision or handoff summary.'},
      taskAction: {type: 'string', enum: ['add', 'start', 'done']},
      title: {type: 'string', description: 'Title for task add.'},
      taskId: {type: 'string', description: 'Task id for task start or done.'},
      to: {type: 'string', description: 'Short lane id for send or handoff.'},
      body: {type: 'string', description: 'Message body for send.'},
      peek: {type: 'boolean', description: 'Leave inbox entries unread.'},
      laneAction: {type: 'string', enum: ['start', 'list', 'assign', 'read', 'wait', 'stop'], description: 'Lead sessions only: what to do with your own lanes.'},
      provider: {type: 'string', description: 'Provider for lane start, such as claude or codex.'},
      prompt: {type: 'string', description: 'First prompt for lane start.'},
      shared: {type: 'boolean', description: 'Run a started lane in the project checkout instead of its own worktree.'},
      lane: {type: 'string', description: 'Short lane id for lane assign, read, or stop.'},
      lanes: {type: 'array', items: {type: 'string'}, description: 'Short lane ids for lane wait; all of your lanes when omitted.'},
      lines: {type: 'number', description: 'Screen lines for lane read.'},
      timeoutSeconds: {type: 'number', description: 'Longest lane wait, in seconds.'}
    },
    required: ['action']
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {text: {type: 'string'}},
    required: ['text']
  },
  execution: {taskSupport: 'forbidden' as const}
};

type Arguments = Record<string, unknown>;
type Request = <T>(method: string, params: Record<string, unknown>) => Promise<T>;
type ToolResult = {content: Array<{type: 'text'; text: string}>; structuredContent: {text: string}; isError?: boolean};
const defaultRequest: Request = (method, params) => daemonRequest(method as Parameters<typeof daemonRequest>[0], params);

function string(value: unknown, name: string, required = true) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!required && value === undefined) return undefined;
  throw new Error(`${name} must be a non-empty string`);
}

function paths(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.some(path => typeof path !== 'string' || !path.trim())) {
    throw new Error('paths must contain one or more non-empty strings');
  }
  return value.map(path => path.trim());
}

/** A lead's lane operation, validated to the same shape `fluent-coord lane` sends. */
function laneOperation(args: Arguments) {
  const action = string(args.laneAction, 'laneAction');
  switch (action) {
    case 'start':
      return {
        action, provider: string(args.provider, 'provider'),
        ...(args.prompt === undefined ? {} : {prompt: string(args.prompt, 'prompt')}),
        ...(args.taskId === undefined ? {} : {taskId: string(args.taskId, 'taskId')}),
        ...(args.shared === true ? {shared: true} : {})
      };
    case 'list':
      return {action};
    case 'assign':
      return {action, lane: string(args.lane, 'lane'), taskId: string(args.taskId, 'taskId')};
    case 'read':
      return {action, lane: string(args.lane, 'lane'), ...(typeof args.lines === 'number' ? {lines: args.lines} : {})};
    case 'wait': {
      if (args.lanes !== undefined && (!Array.isArray(args.lanes) || args.lanes.some(lane => typeof lane !== 'string' || !lane.trim()))) {
        throw new Error('lanes must be a list of lane ids');
      }
      return {
        action,
        ...(Array.isArray(args.lanes) ? {lanes: (args.lanes as string[]).map(lane => lane.trim())} : {}),
        ...(typeof args.timeoutSeconds === 'number' ? {timeoutSeconds: args.timeoutSeconds} : {})
      };
    }
    case 'stop':
      return {action, lane: string(args.lane, 'lane')};
  }
  throw new Error('laneAction must be start, list, assign, read, wait, or stop');
}

function textResult(value: unknown): ToolResult {
  const text = typeof (value as {text?: unknown})?.text === 'string'
    ? (value as {text: string}).text
    : JSON.stringify(value);
  return {content: [{type: 'text', text}], structuredContent: {text}};
}

/** Maps one compact MCP call onto Fluent's existing lane-authenticated RPC surface. */
export async function callFluentCoord(args: Arguments, cwd = process.cwd(), request: Request = defaultRequest): Promise<ToolResult> {
  const action = string(args.action, 'action') as typeof fluentCoordTool.inputSchema.properties.action.enum[number];
  // FLUENT_SESSION_ID names the exact lane when several share this directory (see coord-cli.ts).
  const lane = {cwd, ...(process.env.FLUENT_SESSION_ID ? {sessionId: process.env.FLUENT_SESSION_ID} : {})};
  switch (action) {
    case 'status':
      return textResult(await request('agent.status', {...lane, since: string(args.since, 'since', false)}));
    case 'claim':
      return textResult(await request('agent.claim', {...lane, paths: paths(args.paths)}));
    case 'release':
      return textResult(await request('agent.release', {...lane, paths: paths(args.paths)}));
    case 'note':
      return textResult(await request('agent.note', {...lane, summary: string(args.summary, 'summary')}));
    case 'task': {
      const taskAction = string(args.taskAction, 'taskAction');
      if (taskAction !== 'add' && taskAction !== 'start' && taskAction !== 'done') throw new Error('taskAction must be add, start, or done');
      return textResult(await request('agent.task', {
        ...lane,
        action: taskAction,
        ...(taskAction === 'add' ? {title: string(args.title, 'title')} : {taskId: string(args.taskId, 'taskId')})
      }));
    }
    case 'send':
      return textResult(await request('agent.send', {...lane, to: string(args.to, 'to'), body: string(args.body, 'body')}));
    case 'inbox':
      return textResult(await request('agent.inbox', {...lane, peek: args.peek === true}));
    case 'handoff':
      return textResult(await request('agent.handoff', {...lane, to: string(args.to, 'to'), summary: string(args.summary, 'summary')}));
    case 'lane':
      return textResult(await request('agent.lane', {...lane, ...laneOperation(args)}));
  }
  throw new Error(`Unsupported action: ${action}`);
}

type JsonRpcRequest = {jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>};

function write(output: Writable, message: unknown) {
  output.write(`${JSON.stringify(message)}\n`);
}

/** Minimal stdio MCP server. It deliberately has no state beyond the current request. */
export function serveFluentCoordMcp(input: Readable = process.stdin, output: Writable = process.stdout, cwd = process.cwd(), request: Request = defaultRequest) {
  const lines = createInterface({input, crlfDelay: Infinity});
  lines.on('line', line => {
    void (async () => {
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(line) as JsonRpcRequest;
      } catch {
        write(output, {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}});
        return;
      }
      if (!message.method) {
        if (message.id !== undefined) write(output, {jsonrpc: '2.0', id: message.id, error: {code: -32600, message: 'Invalid request'}});
        return;
      }
      // MCP notifications are intentionally silent.
      if (message.id === undefined) return;
      try {
        if (message.method === 'initialize') {
          write(output, {
            jsonrpc: '2.0', id: message.id,
            result: {protocolVersion: '2025-11-25', capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'fluent-coord', version: '0.1.0'}}
          });
          return;
        }
        if (message.method === 'ping') {
          write(output, {jsonrpc: '2.0', id: message.id, result: {}});
          return;
        }
        if (message.method === 'tools/list') {
          write(output, {jsonrpc: '2.0', id: message.id, result: {tools: [fluentCoordTool]}});
          return;
        }
        if (message.method === 'tools/call') {
          const params = message.params ?? {};
          if (params.name !== fluentCoordTool.name) throw new Error(`Unknown tool: ${String(params.name)}`);
          write(output, {jsonrpc: '2.0', id: message.id, result: await callFluentCoord((params.arguments as Arguments | undefined) ?? {}, cwd, request)});
          return;
        }
        write(output, {jsonrpc: '2.0', id: message.id, error: {code: -32601, message: `Method not found: ${message.method}`}});
      } catch (error) {
        write(output, {
          jsonrpc: '2.0', id: message.id,
          error: {code: -32602, message: error instanceof Error ? error.message : String(error)}
        });
      }
    })();
  });
  return lines;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) serveFluentCoordMcp();
