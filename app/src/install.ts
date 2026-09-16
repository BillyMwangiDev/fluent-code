// One-click installs, shared by the launch sheet and the design workspace. The daemon computes
// the vendor's exact command for this machine; the user sees and approves that command before
// anything runs, and gets the installer's own output back if it fails.
import {api, type InstallAgent, type InstallableTool, type ProviderId} from './api';
import {askConfirm, showActionError, showNotice} from './ui';

/** The executable a provider needs: the OpenCode-bridged providers all need OpenCode itself. */
export function installableToolFor(provider: ProviderId): InstallableTool {
  return provider === 'qwen' || provider === 'glm' || provider === 'nvidia' ? 'opencode' : provider;
}

export async function offerInstall(tool: InstallableTool, trigger: HTMLButtonElement, options: {agent?: InstallAgent; afterInstall?: () => void | Promise<void>} = {}): Promise<boolean> {
  const original = trigger.textContent;
  trigger.disabled = true;
  try {
    const plan = await api.installPlan(tool, options.agent);
    if (!plan.ready) {
      showNotice(`${plan.label}: ${plan.unavailable} Instructions: ${plan.docsUrl}`);
      return false;
    }
    const body = [plan.summary, plan.alsoConfigures ? `It also ${plan.alsoConfigures}.` : '', 'Fluent runs exactly this command as you, and shows you its output.'].filter(Boolean).join(' ');
    if (!(await askConfirm({title: `install ${plan.label}`, body, detail: plan.command, confirmLabel: `install ${plan.label}`}))) return false;
    trigger.textContent = 'installing…';
    const result = await api.installTool(plan, options.agent);
    if (!result.ok) {
      showActionError(new Error(`${plan.label} did not install (exit ${result.exitCode ?? 'unknown'}).\n${result.output.split('\n').slice(-12).join('\n')}`));
      return false;
    }
    showNotice(`${plan.label} installed in ${Math.max(1, Math.round(result.durationMs / 1000))}s.`);
    await options.afterInstall?.();
    return true;
  } catch (error) {
    showActionError(error);
    return false;
  } finally {
    trigger.disabled = false;
    trigger.textContent = original;
  }
}
