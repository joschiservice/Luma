import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { replenishmentSubjects } from '../application/replenishment-workflow.js';

// The web localizes subject text by kind from the English catalog; both must say the same thing.
const catalog = JSON.parse(
  readFileSync(
    new URL('../../../i18n/messages/en/vocabulary.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>;

it('keeps the English message catalog in sync with replenishment subjects', () => {
  for (const subject of replenishmentSubjects) {
    expect(catalog[`vocabulary_subject_${subject.kind}_label`]).toBe(
      subject.label,
    );
    expect(catalog[`vocabulary_subject_${subject.kind}_description`]).toBe(
      subject.description,
    );
  }
});
