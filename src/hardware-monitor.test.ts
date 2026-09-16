import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {availableMemoryFromStatusLevel} from './hardware-monitor.js';

const gb = (value: number) => value * 1024 * 1024 * 1024;

describe('macOS available memory', () => {
  it('turns the kernel free percentage into available bytes', () => {
    // `sysctl -n kern.memorystatus_level` prints the same figure `memory_pressure` reports.
    assert.equal(availableMemoryFromStatusLevel('31\n', gb(8)), Math.round(gb(8) * 0.31));
    assert.equal(availableMemoryFromStatusLevel('100', gb(16)), gb(16));
    assert.equal(availableMemoryFromStatusLevel('0', gb(16)), 0);
  });

  it('rejects anything that is not a percentage, so the caller falls back', () => {
    for (const value of ['', 'abc', '-1', '101', 'NaN', 'Infinity']) {
      assert.equal(availableMemoryFromStatusLevel(value, gb(8)), undefined, JSON.stringify(value));
    }
  });
});
