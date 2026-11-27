import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_ITEMS, filterCommands, stepCommandIndex } from './command-palette';

test('filterCommands matches multi-token queries cleanly', () => {
  assert.equal(filterCommands(COMMAND_ITEMS, '').length, COMMAND_ITEMS.length);
  const matches = filterCommands(COMMAND_ITEMS, 'translucent glass');
  assert.deepEqual(
    matches.map((m) => m.id),
    ['sample-glass'],
  );
});

test('stepCommandIndex wraps and ignores unhandled keys', () => {
  assert.equal(stepCommandIndex('ArrowDown', 2, 3), 0);
  assert.equal(stepCommandIndex('ArrowUp', 0, 3), 2);
  assert.equal(stepCommandIndex('Home', 2, 3), 0);
  assert.equal(stepCommandIndex('End', 0, 3), 2);
  assert.equal(stepCommandIndex('Escape', 0, 3), null);
  assert.equal(stepCommandIndex('ArrowDown', 0, 0), null);
});
