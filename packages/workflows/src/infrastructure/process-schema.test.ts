import { describe, expect, it } from 'vitest';

import { processSource } from '../domain/process.fixture.js';
import { compileProcessWorkflow } from './process-schema.js';

describe('process workflow compiler', () => {
  it('binds every step to the digest and rejects changed published versions', () => {
    const version = compileProcessWorkflow(processSource);
    expect(compileProcessWorkflow(version)).toEqual(version);
    expect(() =>
      compileProcessWorkflow({
        ...version,
        steps: [
          ...version.steps.slice(0, -1),
          { id: 'finish', kind: 'end', outcome: 'different' },
        ],
      }),
    ).toThrow('digest mismatch');
  });
  it('allows policy decisions and requires independent verification for each action', () => {
    const steps = processSource.steps;
    expect(() =>
      compileProcessWorkflow({
        ...processSource,
        steps: [...steps.slice(0, 2), ...steps.slice(3)],
      }),
    ).not.toThrow();
    expect(() =>
      compileProcessWorkflow({
        ...processSource,
        steps: [...steps.slice(0, 4), ...steps.slice(5)],
      }),
    ).toThrow('immediate verification');
    expect(() =>
      compileProcessWorkflow({
        ...processSource,
        steps: [...steps.slice(0, 5), { ...steps[5], id: 'reserve' }, steps[6]],
      }),
    ).toThrow('Step IDs');
  });
  it('rejects unbounded waits and arbitrary code', () => {
    expect(() =>
      compileProcessWorkflow({
        ...processSource,
        steps: [
          ...processSource.steps.slice(0, 5),
          { id: 'pause', kind: 'wait', seconds: 900_000 },
          processSource.steps[6],
        ],
      }),
    ).toThrow();
    expect(() =>
      compileProcessWorkflow({
        ...processSource,
        steps: [
          { id: 'eval', kind: 'typescript', source: 'process.exit()' },
          ...processSource.steps,
        ],
      }),
    ).toThrow();
  });
});
