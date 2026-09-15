import type {SessionSummary} from './daemon-protocol.js';

/** Why a lane is worth interrupting the user for. */
export type AttentionReason = 'finished' | 'failed' | 'needs-input';

/**
 * Whether a lane's new status should reach the user as a notification. A lane that ended on its own
 * should, once per ending; a stop the user asked for, or a lane still working, should not.
 */
export function attentionForStatus(summary: SessionSummary, lastNotifiedStatus?: string): AttentionReason | undefined {
  if (summary.status === lastNotifiedStatus) return undefined;
  if (summary.status === 'failed') return 'failed';
  if (summary.status === 'exited') return summary.exitCode === 0 ? 'finished' : 'failed';
  return undefined;
}

/** Claude Code's own notification text from its `Notification` hook, bounded for a notification body. */
export function attentionDetail(payload: Record<string, unknown>): string | undefined {
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  return message ? message.slice(0, 200) : undefined;
}
