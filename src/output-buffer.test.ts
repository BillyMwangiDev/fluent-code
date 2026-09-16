import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {OutputBuffer} from './output-buffer.js';

describe('lane output buffer', () => {
  it('returns everything while it is under the cap', () => {
    const buffer = new OutputBuffer(100);
    buffer.append('hello ');
    buffer.append('world');

    assert.equal(buffer.text(), 'hello world');
  });

  it('keeps exactly the last cap characters, as concatenating and slicing did', () => {
    const cap = 10;
    const chunks = ['abcde', 'fghij', 'klmno', 'pqrst'];
    const buffer = new OutputBuffer(cap);
    let reference = '';
    for (const chunk of chunks) {
      buffer.append(chunk);
      // The behaviour this replaces, kept as the oracle so the refactor cannot change what a lane shows.
      reference = (reference + chunk).slice(-cap);
      assert.equal(buffer.text(), reference, `after appending ${chunk}`);
    }
    assert.equal(buffer.text(), 'klmnopqrst');
  });

  it('tails a single chunk larger than the cap', () => {
    const buffer = new OutputBuffer(5);
    buffer.append('0123456789');

    assert.equal(buffer.text(), '56789');
  });

  it('retains a bounded amount no matter how much has streamed through it', () => {
    const cap = 1_000;
    const buffer = new OutputBuffer(cap);
    const chunk = 'x'.repeat(200);
    for (let i = 0; i < 10_000; i++) buffer.append(chunk);

    // The whole point of the change: 2MB streamed through, and the buffer still holds about the cap.
    assert.ok(
      buffer.retainedLength() <= cap + chunk.length,
      `retained ${buffer.retainedLength()} for a cap of ${cap}`
    );
    assert.equal(buffer.text().length, cap);
    assert.equal(buffer.text(), 'x'.repeat(cap));
  });

  it('is empty before anything is appended', () => {
    const buffer = new OutputBuffer(10);

    assert.equal(buffer.text(), '');
    assert.equal(buffer.retainedLength(), 0);
  });
});
