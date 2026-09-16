import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {shouldAutoVerify} from './auto-verify.js';

const lane = (over: Partial<Parameters<typeof shouldAutoVerify>[0]> = {}) => ({
  id: 'lane-1',
  status: 'exited' as const,
  worktreePath: '/tmp/worktrees/lane-1',
  verification: undefined,
  ...over
});

describe('automatic verification of an exited lane', () => {
  it('verifies an exited isolated lane', () => {
    assert.equal(shouldAutoVerify(lane(), new Set()), true);
  });

  /**
   * The loop that exhausted the daemon's heap: verifying a lane calls setVerification, which emits
   * a status change, which re-ran this decision. The result is not 'running', so the old guard let
   * it through and verification re-entered itself — about 2,500 suspended frames a second, since an
   * unchanged tree returns a cached result instantly.
   */
  it('does not verify again when the verification result lands and re-emits a status change', () => {
    const attempted = new Set<string>();
    assert.equal(shouldAutoVerify(lane(), attempted), true, 'the first exit starts a verification');

    assert.equal(shouldAutoVerify(lane({verification: 'passed'}), attempted), false, 'a passing result must not re-arm it');
    assert.equal(shouldAutoVerify(lane({verification: 'failed'}), attempted), false, 'nor a failing one');
    assert.equal(shouldAutoVerify(lane({verification: 'unavailable'}), attempted), false, 'nor an unavailable one');
    // A merge can clear the field back to undefined (daemon.ts sets outcome.verification?.status),
    // which must not look like a lane that was never verified.
    assert.equal(shouldAutoVerify(lane({verification: undefined}), attempted), false, 'nor clearing it');
  });

  it('leaves a lane that is still running alone', () => {
    assert.equal(shouldAutoVerify(lane({status: 'running'}), new Set()), false);
  });

  it("leaves a lane sharing the user's own checkout alone", () => {
    assert.equal(shouldAutoVerify(lane({worktreePath: undefined}), new Set()), false);
  });

  it('does not stack a second verification on one already running', () => {
    assert.equal(shouldAutoVerify(lane({verification: 'running'}), new Set()), false);
  });

  /**
   * Resuming never clears a lane's previous verification, so "verified once, never again" would
   * silently stop checking any lane the user resumed. Leaving the exited state is what re-arms it.
   */
  it('verifies a resumed lane again once it exits a second time', () => {
    const attempted = new Set<string>();
    assert.equal(shouldAutoVerify(lane(), attempted), true);
    assert.equal(shouldAutoVerify(lane({verification: 'passed'}), attempted), false);

    assert.equal(shouldAutoVerify(lane({status: 'starting', verification: 'passed'}), attempted), false, 'a starting lane is not itself verified');
    assert.equal(shouldAutoVerify(lane({verification: 'passed'}), attempted), true, 'its next exit earns a fresh verification');
  });

  it('tracks lanes separately', () => {
    const attempted = new Set<string>();
    assert.equal(shouldAutoVerify(lane(), attempted), true);
    assert.equal(shouldAutoVerify(lane({id: 'lane-2'}), attempted), true, 'another lane still gets its own verification');
    assert.equal(shouldAutoVerify(lane(), attempted), false);
  });
});
