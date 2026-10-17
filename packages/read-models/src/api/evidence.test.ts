import {
  evidenceRecordKinds as contractRecordKinds,
  evidenceReferenceLimit as contractLimit,
  evidenceSummaryFields as contractSummaryFields,
} from '@luma/api-contract';
import { expect, it } from 'vitest';

import {
  evidenceRecordKinds,
  evidenceReferenceLimit,
  evidenceSummaryFields,
} from '../domain/evidence.js';

it('resolves evidence within the limits and vocabulary the contract publishes', () => {
  expect(evidenceSummaryFields).toEqual(contractSummaryFields);
  expect(evidenceRecordKinds).toEqual(contractRecordKinds);
  expect(evidenceReferenceLimit).toBe(contractLimit);
});
