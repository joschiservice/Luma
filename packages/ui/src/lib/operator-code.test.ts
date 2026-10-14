import { readFileSync } from 'node:fs';

import { installedConnectionSchema } from '@luma/api-contract';
import { expect, it } from 'vitest';

import { inventoryCase } from '../components/issues/case-fixtures';
import { operatorCodeMessages } from './operator-code';

it('labels every installed capability and golden detector outcome', () => {
  const corpus = JSON.parse(
    readFileSync(
      new URL(
        '../../../exceptions/fixtures/exceptions-v0.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const codes = [
    ...installedConnectionSchema.shape.permissions.element.options,
    ...inventoryCase.diagnosis!.provenance.evidence.flatMap((item) =>
      item.source ? [item.source.resource.toLowerCase()] : [],
    ),
    ...corpus.cases.map(
      (item: { expected: { reason: string } }) => item.expected.reason,
    ),
  ];
  for (const code of codes)
    expect(operatorCodeMessages[code], code).toBeTypeOf('function');
});
