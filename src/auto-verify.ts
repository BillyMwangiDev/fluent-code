import type {SessionSummary} from './daemon-protocol.js';

type AutoVerifyLane = Pick<SessionSummary, 'id' | 'status' | 'worktreePath' | 'verification'>;

/**
 * Decides whether an exited lane should have the project's own checks run against it unasked.
 *
 * The rule this exists to state is "at most once per exit". Recording a verification result calls
 * `setVerification`, which emits a status change, which brings the daemon straight back here — and
 * a result of `passed` is not `running`, so a guard written only against `running` let it back in.
 * Verification then re-entered itself through its own completion. Each re-entry began a new async
 * frame while the previous one was still suspended, so the frames nested instead of unwinding:
 * roughly 2,500 a second, because an unchanged tree returns a cached result instantly. A daemon
 * with two lanes reached a 2GB heap in about five minutes and died.
 *
 * Leaving the exited state is what re-arms a lane. Resuming never clears a previous verification,
 * so keying off that field alone would quietly stop checking every lane the user ever resumed,
 * while a lane that exits a second time has a changed tree and has earned a fresh check.
 *
 * `attempted` is owned by the caller so this stays a pure decision that a test can drive directly;
 * the daemon holds one set for its lifetime and drops a lane from it when the session is deleted.
 */
export function shouldAutoVerify(lane: AutoVerifyLane, attempted: Set<string>): boolean {
  if (lane.status !== 'exited') {
    attempted.delete(lane.id);
    return false;
  }
  // A lane sharing the user's own checkout is deliberately left alone: running their suite
  // unprompted in their working tree is intrusive in a way it is not in a lane opened for one task.
  if (!lane.worktreePath) return false;
  if (lane.verification === 'running') return false;
  if (attempted.has(lane.id)) return false;
  attempted.add(lane.id);
  return true;
}
