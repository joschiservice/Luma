import { expect, it } from 'vitest';

import {
  requireAllocationMode,
  requireOwnershipTransition,
} from './ownership.js';

it('requires the explicit location path and a separate handback', () => {
  for (const [from, to] of [
    ['observe', 'shadow'],
    ['shadow', 'propose'],
    ['propose', 'own'],
    ['own', 'observe'],
  ] as const)
    expect(() => requireOwnershipTransition(from, to)).not.toThrow();
  expect(() => requireOwnershipTransition('observe', 'own')).toThrow();
  expect(() => requireOwnershipTransition('shadow', 'own')).toThrow();
  expect(() => requireOwnershipTransition('own', 'shadow')).toThrow();
  expect(() => requireAllocationMode('observe')).toThrow();
  expect(() => requireAllocationMode('shadow')).not.toThrow();
});
