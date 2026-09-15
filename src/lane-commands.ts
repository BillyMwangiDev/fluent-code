import {providerIds, type LaneOperation, type ProviderId} from './daemon-protocol.js';

/**
 * Parses `fluent-coord lane …` for a lead lane. Kept apart from the daemon-side lane code so the
 * command every agent runs on each check-in does not load a terminal emulator it never uses.
 */
const usage = {
  any: 'usage: fluent-coord lane start|list|assign|read|wait|stop',
  start: 'usage: fluent-coord lane start PROVIDER [--shared] [--task ID] PROMPT...',
  assign: 'usage: fluent-coord lane assign LANE TASK',
  read: 'usage: fluent-coord lane read LANE [--lines N]',
  stop: 'usage: fluent-coord lane stop LANE'
};

export function isLaneProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (providerIds as readonly string[]).includes(value);
}

function takeFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const [, value] = args.splice(index, 2);
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

function takeCount(args: string[], flag: string) {
  const value = takeOption(args, flag);
  if (value === undefined) return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) throw new Error(`${flag} needs a number`);
  return count;
}

export function parseLaneArguments(argv: readonly string[]): LaneOperation {
  const [action, ...rest] = argv;
  const args = [...rest];
  switch (action) {
    case 'start': {
      const shared = takeFlag(args, '--shared');
      const taskId = takeOption(args, '--task');
      const [provider, ...prompt] = args;
      if (!provider) throw new Error(usage.start);
      if (!isLaneProvider(provider)) throw new Error(`Unknown provider ${provider}: use one of ${providerIds.join(', ')}`);
      return {action, provider, ...(taskId ? {taskId} : {}), ...(shared ? {shared} : {}), ...(prompt.length > 0 ? {prompt: prompt.join(' ')} : {})};
    }
    case 'list':
      return {action};
    case 'assign': {
      const [lane, taskId] = args;
      if (!lane || !taskId) throw new Error(usage.assign);
      return {action, lane, taskId};
    }
    case 'read': {
      const lines = takeCount(args, '--lines');
      const [lane] = args;
      if (!lane) throw new Error(usage.read);
      return {action, lane, ...(lines ? {lines} : {})};
    }
    case 'wait': {
      const timeoutSeconds = takeCount(args, '--timeout');
      return {action, lanes: args, ...(timeoutSeconds ? {timeoutSeconds} : {})};
    }
    case 'stop': {
      const [lane] = args;
      if (!lane) throw new Error(usage.stop);
      return {action, lane};
    }
    default:
      throw new Error(usage.any);
  }
}
