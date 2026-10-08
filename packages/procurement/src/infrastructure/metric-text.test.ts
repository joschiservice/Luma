import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import {
  procurementMetricDefinitions,
  stockMetricDefinitions,
} from '../domain/metrics.js';

// The web localizes metric definitions by ID from the English catalog; both must say the same thing.
const catalog = JSON.parse(
  readFileSync(
    new URL('../../../i18n/messages/en/metrics.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>;

it('keeps the English message catalog in sync with metric definitions', () => {
  for (const definition of [
    ...procurementMetricDefinitions,
    ...stockMetricDefinitions,
  ]) {
    const key = `metrics_${definition.id.replaceAll(/[.:-]/g, '_')}`;
    expect(catalog[`${key}_title`]).toBe(definition.title);
    expect(catalog[`${key}_description`]).toBe(definition.description);
    expect(catalog[`${key}_time_semantics`]).toBe(definition.timeSemantics);
  }
});
