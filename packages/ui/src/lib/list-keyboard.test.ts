import { describe, expect, it } from 'vitest';

import {
  focusedRowIndex,
  isTypingTarget,
  listShortcutForKey,
} from './list-keyboard';

const press = (
  key: string,
  modifiers: Partial<Record<string, boolean>> = {},
) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...modifiers,
});

describe('listShortcutForKey', () => {
  it('maps navigation, opening and preview keys', () => {
    expect(listShortcutForKey(press('j'))).toBe('next');
    expect(listShortcutForKey(press('ArrowDown'))).toBe('next');
    expect(listShortcutForKey(press('k'))).toBe('previous');
    expect(listShortcutForKey(press('ArrowUp'))).toBe('previous');
    expect(listShortcutForKey(press('Enter'))).toBe('open');
    expect(listShortcutForKey(press(' '))).toBe('preview');
    expect(listShortcutForKey(press('Escape'))).toBe('escape');
  });

  it('treats caps lock letters like lowercase ones', () => {
    expect(listShortcutForKey(press('J'))).toBe('next');
    expect(listShortcutForKey(press('F'))).toBe('filter');
  });

  it('extends the selection with Shift+X and toggles it with X', () => {
    expect(listShortcutForKey(press('x'))).toBe('toggle-selection');
    expect(listShortcutForKey(press('X', { shiftKey: true }))).toBe(
      'extend-selection',
    );
  });

  it('accepts / and ? whether or not the layout needs Shift for them', () => {
    expect(listShortcutForKey(press('/'))).toBe('search');
    expect(listShortcutForKey(press('/', { shiftKey: true }))).toBe('search');
    expect(listShortcutForKey(press('?', { shiftKey: true }))).toBe('help');
  });

  it('leaves presses with modifiers and other Shift combinations to the browser', () => {
    expect(listShortcutForKey(press('j', { metaKey: true }))).toBeUndefined();
    expect(listShortcutForKey(press('f', { ctrlKey: true }))).toBeUndefined();
    expect(listShortcutForKey(press('x', { altKey: true }))).toBeUndefined();
    expect(listShortcutForKey(press('J', { shiftKey: true }))).toBeUndefined();
    expect(
      listShortcutForKey(press('ArrowDown', { shiftKey: true })),
    ).toBeUndefined();
    expect(listShortcutForKey(press('q'))).toBeUndefined();
  });
});

describe('isTypingTarget', () => {
  it('is false without an element', () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('focusedRowIndex', () => {
  const keys = ['a', 'b', 'c'];

  it('follows the focused record when a refresh moves it', () => {
    expect(focusedRowIndex({ count: 3, index: 0, key: 'c', keys })).toBe(2);
  });

  it('keeps the position when the focused record leaves the list', () => {
    expect(
      focusedRowIndex({ count: 2, index: 2, key: 'gone', keys: ['a', 'b'] }),
    ).toBe(1);
    expect(focusedRowIndex({ count: 0, index: 1, key: 'a', keys: [] })).toBe(
      -1,
    );
  });

  it('starts from the record open in the preview before the reader moves', () => {
    expect(focusedRowIndex({ count: 3, index: -1, keys, open: 'b' })).toBe(1);
    expect(focusedRowIndex({ count: 3, index: -1, keys, open: 'zz' })).toBe(-1);
  });

  it('works by position without keys', () => {
    expect(focusedRowIndex({ count: 3, index: 5 })).toBe(2);
    expect(focusedRowIndex({ count: 3, index: -1 })).toBe(-1);
  });
});
