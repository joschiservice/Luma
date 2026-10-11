import { expect, it } from 'vitest';

import { validateHumanTaskAnswer } from './coordination.js';

it('validates choices, required evidence and safe evidence links', () => {
  const task = { choices: ['Confirmed'], evidence: 'link' as const };
  expect(() =>
    validateHumanTaskAnswer(task, {
      choice: 'Confirmed',
      evidence: {
        kind: 'link',
        value: 'https://supplier.example/confirmation',
      },
    }),
  ).not.toThrow();
  for (const answer of [
    {
      choice: 'Unknown',
      evidence: { kind: 'link' as const, value: 'https://example.test' },
    },
    { choice: 'Confirmed', evidence: { kind: 'text' as const, value: 'Yes' } },
    {
      choice: 'Confirmed',
      evidence: { kind: 'link' as const, value: 'javascript:alert(1)' },
    },
    {
      choice: 'Confirmed',
      evidence: {
        kind: 'link' as const,
        value: 'https://user:secret@example.test',
      },
    },
  ])
    expect(() => validateHumanTaskAnswer(task, answer)).toThrow();
});
