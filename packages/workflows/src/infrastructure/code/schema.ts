import { z } from 'zod';

import { codeRuntime, type CodeStep } from '../../domain/code-step.js';
import { playbookHash } from '../playbooks/schema.js';

const key = z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/);

/** Validates the published resource envelope before starting a sandbox. */
export const codeStepSchema = z
  .object({
    id: key,
    kind: z.literal('code'),
    source: z.string().min(1).max(32768),
    runtime: z.literal(codeRuntime),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    fields: z.record(key, z.enum(['string', 'number', 'boolean', 'null'])),
    grants: z.array(key).max(16),
    limits: z
      .object({
        fuel: z.number().int().min(10000).max(1000000000),
        memoryBytes: z.number().int().min(16777216).max(134217728),
        wallTimeMs: z.number().int().min(100).max(30000),
        maxRequests: z.number().int().min(0).max(32),
      })
      .strict(),
  })
  .strict();

/** Binds source, runtime, output schema, permissions and resource limits to one artifact. */
export function codeArtifactDigest(
  step: Omit<CodeStep, 'artifactDigest'>,
): string {
  return playbookHash(step);
}

/** Builds a reviewable code instruction; publication still requires workflow authorization. */
export function defineCodeStep(
  step: Omit<CodeStep, 'artifactDigest' | 'kind' | 'runtime'>,
): CodeStep {
  const contract: Omit<CodeStep, 'artifactDigest'> = {
    id: step.id,
    source: step.source,
    fields: step.fields,
    grants: step.grants,
    limits: step.limits,
    kind: 'code',
    runtime: codeRuntime,
  };

  return codeStepSchema.parse({
    ...contract,
    artifactDigest: codeArtifactDigest(contract),
  });
}

/** Rejects tampering with any part of an immutable code artifact. */
export function checkCodeStep(input: unknown): CodeStep {
  const step = codeStepSchema.parse(input);
  const { artifactDigest, ...contract } = step;
  if (codeArtifactDigest(contract) !== artifactDigest)
    throw new Error('Code artifact digest mismatch');
  if (new Set(step.grants).size !== step.grants.length)
    throw new Error('Code grants must be unique');

  return step;
}
