import { describe, it, expect } from 'vitest';
import { COMMAND_ITEMS, filterCommands, stepCommandIndex } from './command-palette';

describe('command-palette pure logic', () => {
  it('returns all commands when the query is blank', () => {
    expect(filterCommands(COMMAND_ITEMS, '')).toHaveLength(COMMAND_ITEMS.length);
    expect(filterCommands(COMMAND_ITEMS, '   ')).toHaveLength(COMMAND_ITEMS.length);
  });

  it('filters by multi-word case-insensitive terms across label, description, and keywords', () => {
    const bulk = filterCommands(COMMAND_ITEMS, 'zip bulk');
    expect(bulk.map((item) => item.id)).toEqual(['studio-bulk']);

    const dog = filterCommands(COMMAND_ITEMS, 'FUR dog');
    expect(dog.map((item) => item.id)).toEqual(['sample-dog']);

    const light = filterCommands(COMMAND_ITEMS, 'theme clean');
    expect(light.map((item) => item.id)).toEqual(['theme-light']);
  });

  it('returns empty array when no command matches', () => {
    expect(filterCommands(COMMAND_ITEMS, 'nonexistent-xyz-term')).toEqual([]);
  });

  it('wraps keyboard navigation cleanly with ArrowDown, ArrowUp, Home, and End', () => {
    expect(stepCommandIndex('ArrowDown', -1, 4)).toBe(0);
    expect(stepCommandIndex('ArrowDown', 3, 4)).toBe(0);
    expect(stepCommandIndex('ArrowUp', 0, 4)).toBe(3);
    expect(stepCommandIndex('Home', 2, 4)).toBe(0);
    expect(stepCommandIndex('End', 1, 4)).toBe(3);
    expect(stepCommandIndex('Enter', 1, 4)).toBeNull();
    expect(stepCommandIndex('ArrowDown', 0, 0)).toBeNull();
  });
});
