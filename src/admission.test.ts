import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {AdmissionAdvisor, assessAdmission, percentile, processTreeBytes, reserveBytes, type AdmissionInput} from './admission.js';
import type {ProcessSample} from './resource-monitor-client.js';

const gb = (count: number) => count * 1024 * 1024 * 1024;

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    provider: 'claude',
    runningLanes: 1,
    memoryTotalBytes: gb(32),
    memoryUsedBytes: gb(8),
    observedLaneBytes: [],
    ...overrides
  };
}

function process(pid: number, ppid: number, residentBytes: number): ProcessSample {
  return {
    pid, ppid, residentBytes, startTimeMs: 0, runTimeMs: 0, name: 'node', command: 'node',
    status: 'running', cpuPercent: 0, cpuTimeMs: 0, virtualBytes: 0, ioReadBytes: 0, ioWriteBytes: 0,
    ioSemantics: 'all-io'
  };
}

describe('costing a lane', () => {
  it('counts everything the lane spawned, not just its own process', () => {
    const processes = [process(100, 1, gb(0.3)), process(101, 100, gb(0.5)), process(102, 101, gb(0.2)), process(200, 1, gb(9))];

    assert.equal(processTreeBytes(processes, 100), gb(1), 'a child of a child still belongs to the lane');
  });

  it('reports nothing for a process that is gone, rather than zero', () => {
    assert.equal(processTreeBytes([process(100, 1, gb(1))], 999), undefined);
  });

  it('does not hang on a cycle in the reported parentage', () => {
    const processes = [process(100, 101, gb(1)), process(101, 100, gb(1))];

    assert.equal(processTreeBytes(processes, 100), gb(2));
  });

  it('takes the heavy lane, not the average one', () => {
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
    assert.equal(percentile([5], 0.9), 5);
    assert.equal(percentile([], 0.9), undefined);
  });
});

describe('assessing room for another lane', () => {
  it('says how many more lanes would fit', () => {
    const verdict = assessAdmission(input({memoryTotalBytes: gb(32), memoryUsedBytes: gb(8)}));

    // 24 GB free, minus a ~3.84 GB reserve, over a 0.8 GB default estimate.
    assert.equal(verdict.decision, 'clear');
    assert.ok(verdict.recommendedLanes > 20);
    assert.match(verdict.reasons[0]!, /Room for about \d+ more lanes/);
  });

  it('calls it over when the free memory will not carry one', () => {
    const verdict = assessAdmission(input({memoryTotalBytes: gb(8), memoryUsedBytes: gb(7.5)}));

    assert.equal(verdict.decision, 'over');
    assert.equal(verdict.recommendedLanes, 0);
    assert.match(verdict.reasons[0]!, /Not enough free memory/);
  });

  it('calls it tight when exactly one would fit', () => {
    // Reserve on a 16 GB machine is 2 GB; leave a little over one 0.8 GB lane above it.
    const verdict = assessAdmission(input({memoryTotalBytes: gb(16), memoryUsedBytes: gb(16) - gb(2) - gb(1.2)}));

    assert.equal(verdict.decision, 'tight');
    assert.equal(verdict.recommendedLanes, 1);
  });

  it('keeps memory back for everything that is not a lane', () => {
    assert.equal(reserveBytes(gb(8)), gb(2), 'a small machine still keeps a floor');
    assert.equal(reserveBytes(gb(64)), gb(64) * 0.12, 'a large one keeps a proportion');
  });
});

describe('learning what a lane costs here', () => {
  it('prefers this machine\'s own measurements once there are enough', () => {
    const verdict = assessAdmission(input({observedLaneBytes: [gb(2), gb(3), gb(4), gb(9)]}));

    assert.equal(verdict.estimateSource, 'observed');
    assert.equal(verdict.perLaneBytes, gb(9));
    assert.match(verdict.reasons[1]!, /90th percentile of 4 lanes measured on this machine/);
  });

  it('says plainly when it is still guessing', () => {
    const verdict = assessAdmission(input({observedLaneBytes: [gb(2), gb(3)]}));

    assert.equal(verdict.estimateSource, 'default');
    assert.match(verdict.reasons[1]!, /is a default/);
  });

  it('records the cost of each running lane from a real snapshot', () => {
    const advisor = new AdmissionAdvisor();
    const processes = [process(100, 1, gb(1)), process(101, 100, gb(0.5)), process(200, 1, gb(2))];

    advisor.sample([{provider: 'claude', pid: 100}, {provider: 'codex', pid: 200}], processes);

    assert.deepEqual(advisor.observed('claude'), [gb(1.5)]);
    assert.deepEqual(advisor.observed('codex'), [gb(2)]);
  });

  it('skips a lane it cannot find rather than recording it as free', () => {
    const advisor = new AdmissionAdvisor();

    advisor.sample([{provider: 'claude', pid: 999}, {provider: 'claude', pid: undefined}], [process(100, 1, gb(1))]);

    assert.deepEqual(advisor.observed('claude'), [], 'a missing process is unknown, not zero');
  });

  it('keeps the estimate to what the machine has been doing lately', () => {
    const advisor = new AdmissionAdvisor();
    for (let sample = 0; sample < 60; sample++) {
      advisor.sample([{provider: 'claude', pid: 100}], [process(100, 1, gb(1))]);
    }

    assert.equal(advisor.observed('claude').length, 40);
  });
});

describe('quota as the other kind of headroom', () => {
  it('warns near the end of a window', () => {
    const verdict = assessAdmission(input({quota: {window: {usedPercent: 94, windowMinutes: 300}, accountId: 'work-sub'}}));

    assert.equal(verdict.decision, 'tight');
    assert.equal(verdict.accountId, 'work-sub');
    assert.match(verdict.reasons.join(' '), /at 94% of its window/);
  });

  it('treats a spent window as no room at all, whatever the memory says', () => {
    const verdict = assessAdmission(input({
      memoryTotalBytes: gb(64),
      memoryUsedBytes: gb(4),
      quota: {window: {usedPercent: 100, windowMinutes: 300, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString()}}
    }));

    assert.equal(verdict.decision, 'over');
    assert.ok(verdict.recommendedLanes > 0, 'memory was never the problem');
    assert.match(verdict.reasons.join(' '), /quota is spent, resetting in about 2 hours/);
    assert.match(verdict.reasons.join(' '), /fail after you have invested attention/);
  });

  it('says nothing about quota when the provider has not reported any', () => {
    const verdict = assessAdmission(input());

    assert.equal(verdict.quotaUsedPercent, undefined);
    assert.doesNotMatch(verdict.reasons.join(' '), /window/);
  });

  it('takes the worse of the two, never the kinder one', () => {
    const verdict = assessAdmission(input({
      memoryTotalBytes: gb(8),
      memoryUsedBytes: gb(7.5),
      quota: {window: {usedPercent: 3, windowMinutes: 300}}
    }));

    assert.equal(verdict.decision, 'over', 'plenty of quota does not buy memory');
  });
});
