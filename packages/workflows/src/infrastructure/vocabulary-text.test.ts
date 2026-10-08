import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { mergeVocabulary } from '../domain/vocabulary.js';

// The web localizes trigger and step text by kind from the English catalog; both must agree.
const catalog = JSON.parse(
  readFileSync(
    new URL('../../../i18n/messages/en/vocabulary.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>;

it('keeps the English message catalog in sync with triggers and step kinds', () => {
  const vocabulary = mergeVocabulary([], {
    runtime: 'test',
    limits: { fuel: 1, memoryBytes: 1, wallTimeMs: 1, maxRequests: 1 },
  });

  for (const [group, entries] of [
    ['trigger', vocabulary.triggers],
    ['step', vocabulary.stepKinds],
  ] as const)
    for (const entry of entries) {
      expect(catalog[`vocabulary_${group}_${entry.kind}_label`]).toBe(
        entry.label,
      );
      expect(catalog[`vocabulary_${group}_${entry.kind}_description`]).toBe(
        entry.description,
      );
    }
});
