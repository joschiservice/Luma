import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { shippingMethodVocabulary } from '../application/shipping-method-authoring.js';

// The web localizes subject text by kind from the English catalog; both must say the same thing.
const catalog = JSON.parse(
  readFileSync(
    new URL('../../../i18n/messages/en/vocabulary.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>;

it('keeps the English message catalog in sync with shipping-method subjects', async () => {
  const { subjects = [] } = await shippingMethodVocabulary.vocabulary();

  expect(subjects.length).toBeGreaterThan(0);
  for (const subject of subjects) {
    expect(catalog[`vocabulary_subject_${subject.kind}_label`]).toBe(
      subject.label,
    );
    expect(catalog[`vocabulary_subject_${subject.kind}_description`]).toBe(
      subject.description,
    );
  }
});
