import test from 'node:test';
import assert from 'node:assert/strict';
import {diffById, gridShape, nextFocus} from './lane-layout';

test('grid shape: one lane fills the plane, two sit side by side, small counts split evenly', () => {
  assert.deepEqual(gridShape(1, 1200, 800), {columns: 1, rows: 1});
  assert.deepEqual(gridShape(2, 1200, 800), {columns: 2, rows: 1});
  assert.deepEqual(gridShape(3, 1200, 800), {columns: 2, rows: 2});
  assert.deepEqual(gridShape(4, 1200, 800), {columns: 2, rows: 2});
  assert.deepEqual(gridShape(6, 1300, 800), {columns: 3, rows: 2});
});

test('grid shape adds rows on a narrow plane instead of squeezing columns, and never returns zero', () => {
  const narrow = gridShape(10, 700, 900);
  assert.equal(narrow.columns, 2);
  assert.equal(narrow.rows, 5);
  assert.deepEqual(gridShape(0, 1200, 800), {columns: 1, rows: 1});
  const ten = gridShape(10, 1440, 820);
  assert.ok(ten.columns * ten.rows >= 10);
  assert.ok(ten.columns >= 3 && ten.columns <= 4);
});

test('diffById reports adds, removes, and kept records in next order', () => {
  const diff = diffById([{id: 'a'}, {id: 'b'}], [{id: 'b'}, {id: 'c'}]);
  assert.deepEqual(diff.added, [{id: 'c'}]);
  assert.deepEqual(diff.removed, ['a']);
  assert.deepEqual(diff.kept, [{id: 'b'}]);
});

test('nextFocus moves to a neighbour when the focused lane disappears', () => {
  assert.equal(nextFocus(['a', 'b', 'c'], 'b', ['b']), 'c');
  assert.equal(nextFocus(['a', 'b', 'c'], 'c', ['c']), 'b');
  assert.equal(nextFocus(['a'], 'a', ['a']), undefined);
  assert.equal(nextFocus(['a', 'b'], 'a', []), 'a');
  assert.equal(nextFocus(['a', 'b'], undefined, []), 'a');
  assert.equal(nextFocus(['a', 'b'], 'zzz', []), 'a');
});
