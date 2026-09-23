import {
  learningCommandSchema,
  startResolutionRunSchema,
} from '@luma/api-contract';
import { z } from 'zod';

export const learningBoundary = {
  parseStart: (input: unknown) => startResolutionRunSchema.parse(input),
  parseEvent: (input: unknown) => learningCommandSchema.parse(input),
  parseId: (input: string) => z.string().uuid().parse(input),
};
