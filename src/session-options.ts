import type {ProviderId} from './daemon-protocol.js';
import {isOpenCodeAdapter, providerAdapter} from './providers.js';

/**
 * The model and permission choices a user can make when starting a lane, passed through each CLI's
 * own flags (`claude --model/--permission-mode`, `codex -m/-s`). Fluent never loosens a dial by
 * itself: the modes that remove a CLI's own safety prompts are marked risky so fluentd can require
 * an approval before launching with one.
 */
const permissionChoices: Partial<Record<ProviderId, readonly string[]>> = {
  claude: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
  codex: ['read-only', 'workspace-write', 'danger-full-access']
};
const riskyChoices: Partial<Record<ProviderId, readonly string[]>> = {claude: ['bypassPermissions'], codex: ['danger-full-access']};
/** One word that cannot be read as an option: an alias like `opus` or a full model id. */
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

export type SessionOptions = {model?: string; permissionMode?: string};

export function permissionModes(provider: ProviderId): readonly string[] {
  return permissionChoices[provider] ?? [];
}

export function isRiskyPermission(provider: ProviderId, mode?: string) {
  return Boolean(mode && riskyChoices[provider]?.includes(mode));
}

export function sessionOptionArgs(provider: ProviderId, {model, permissionMode}: SessionOptions): string[] {
  const chosenModel = model?.trim() || undefined;
  const chosenMode = permissionMode?.trim() || undefined;
  if (!chosenModel && !chosenMode) return [];
  const adapter = providerAdapter(provider);
  if (isOpenCodeAdapter(adapter)) throw new Error(`${adapter.label} takes its model from the selected account`);
  if (provider !== 'claude' && provider !== 'codex') throw new Error(`${adapter.label} does not take a model or permission mode from Fluent yet`);
  if (chosenModel && !modelPattern.test(chosenModel)) throw new Error('A model name is one word of letters, digits, and . _ - : [ ]');
  if (chosenMode && !permissionModes(provider).includes(chosenMode)) throw new Error(`${adapter.label} has no permission mode "${chosenMode}"`);
  const args: string[] = [];
  if (chosenModel) args.push(provider === 'claude' ? '--model' : '-m', chosenModel);
  if (chosenMode) args.push(provider === 'claude' ? '--permission-mode' : '-s', chosenMode);
  return args;
}
