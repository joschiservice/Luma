import {
  shadowRequestSchema,
  shadowReviewSchema,
  shadowWindowSchema,
} from '@luma/api-contract';
import { canonicalJson as canonicalPlaybook } from '@luma/platform';
import { z } from 'zod';

import type { ShadowReview } from '../application/shadow-evaluation.js';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw Object.assign(new Error('Invalid Shadow request'), {
      statusCode: 400,
    });

  return result.data;
}

/** Validates Shadow requests and compares business action fields without proposal identities. */
export const shadowBoundary = {
  parseRequest: (input: unknown) => parse(shadowRequestSchema, input),
  parseReview: (input: unknown) => parse(shadowReviewSchema, input),
  parseWindow: (input: unknown) => parse(shadowWindowSchema, input),
  parseId: (input: string) => parse(z.string().uuid(), input),
  sameAction: (
    a: ShadowReview['operatorAction'],
    b: ShadowReview['operatorAction'],
  ) => {
    const business = (action: ShadowReview['operatorAction']) =>
      action && {
        capability: action.capability,
        target: action.target,
        parameters: action.parameters,
        expectedPostcondition: action.expectedPostcondition,
      };

    return canonicalPlaybook(business(a)) === canonicalPlaybook(business(b));
  },
};
