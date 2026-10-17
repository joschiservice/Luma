import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import {
  exceptionClassLabels,
  otherExceptionClassLabel,
} from '../domain/labels.js';

// The web localizes issue kinds by class from the English catalog; both must say the same thing.
const catalog = JSON.parse(
  readFileSync(
    new URL('../../../i18n/messages/en/issues.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>;

it('keeps the English message catalog in sync with exception class labels', () => {
  for (const [exceptionClass, label] of Object.entries(exceptionClassLabels))
    expect(catalog[`issues_kind_${exceptionClass}`]).toBe(label);
  expect(catalog.issues_kind_other).toBe(otherExceptionClassLabel);
});
