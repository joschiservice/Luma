import { describe, expect, it } from 'vitest';

import { processSource } from '../domain/process.fixture.js';
import {
  checkDraftContent,
  checkProcessWorkflow,
  compileProcessWorkflow,
  draftFromVersion,
  parseDraftShape,
} from './process-schema.js';

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

describe('draft diagnostics', () => {
  const provenance = {
    kind: 'native' as const,
    reference: 'draft:1@1',
    authoredBy: 'user',
    evidenceRefs: ['draft:1'],
  };
  const content = {
    schemaVersion: processSource.schemaVersion,
    definition: processSource.definition,
    version: processSource.version,
    applicability: processSource.applicability,
    inputs: processSource.inputs,
    context: processSource.context,
    steps: processSource.steps,
  };

  it('reports every rule violation on the step and field to change', () => {
    const { version, diagnostics } = checkProcessWorkflow({
      ...processSource,
      steps: [
        processSource.steps[0],
        { ...processSource.steps[1], equals: 'yes' },
        {
          ...processSource.steps[3],
          parameters: {
            quantity: { source: 'step', stepId: 'later', field: 'value' },
          },
        },
        processSource.steps[6],
      ],
    });
    expect(version).toBeNull();
    expect(
      diagnostics.map((item) => [item.code, item.stepId, item.field]),
    ).toEqual([
      ['condition_field', 'eligible', 'equals'],
      ['unavailable_output', 'reserve', 'parameters.quantity'],
      ['missing_verification', 'reserve', null],
    ]);
    expect(diagnostics[0]!.message).toContain('boolean');
  });

  it('maps schema problems to plain-language messages', () => {
    const { diagnostics } = checkProcessWorkflow({
      ...processSource,
      definition: { ...processSource.definition, name: '' },
      steps: [
        { ...processSource.steps[0], kind: 'typescript' },
        ...processSource.steps.slice(1),
      ],
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        field: 'definition.name',
        stepIndex: null,
        message: "Name can't be empty.",
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        stepIndex: 0,
        stepId: 'refresh',
        field: 'kind',
        message: 'Choose a supported step type.',
      }),
    );
  });

  it('saves incomplete drafts but rejects unreadable structure', () => {
    expect(
      parseDraftShape({
        ...content,
        definition: { ...content.definition, name: '' },
        steps: [{ id: '', kind: 'end', outcome: '' }],
      }).content,
    ).not.toBeNull();
    const unreadable = parseDraftShape({
      ...content,
      steps: [{ id: 'x', kind: 'shell', command: 'rm' }],
    });
    expect(unreadable.content).toBeNull();
    expect(unreadable.diagnostics[0]).toEqual(
      expect.objectContaining({ stepIndex: 0, field: 'kind' }),
    );
  });

  it('binds draft Code Steps at publication and round-trips published versions', () => {
    const draft = {
      ...content,
      steps: [
        {
          id: 'calculate',
          kind: 'code' as const,
          source:
            'function main(input) { return { ready: input.evidence.ready }; }',
          fields: { ready: 'boolean' as const },
          grants: [],
          limits: {
            fuel: 100_000_000,
            memoryBytes: 67_108_864,
            wallTimeMs: 5000,
            maxRequests: 0,
          },
        },
        processSource.steps[1],
        processSource.steps[6],
      ],
    };
    const checked = checkDraftContent(draft, provenance);
    expect(checked.diagnostics).toEqual([]);
    const code = checked.version!.steps[0]!;
    expect(code).toEqual(
      expect.objectContaining({
        runtime: expect.any(String),
        artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(compileProcessWorkflow(checked.version)).toEqual(checked.version);
    const again = checkDraftContent(
      draftFromVersion(checked.version!),
      provenance,
    );
    expect(again.version!.digest).toBe(checked.version!.digest);
  });

  it('reports invalid Code Step source on the source field', () => {
    const checked = checkDraftContent(
      {
        ...content,
        steps: [
          {
            id: 'calculate',
            kind: 'code',
            source: 'import fs from "fs"; async function main() {}',
            fields: {},
            grants: [],
            limits: {
              fuel: 100_000_000,
              memoryBytes: 67_108_864,
              wallTimeMs: 5000,
              maxRequests: 0,
            },
          },
          processSource.steps[6],
        ],
      },
      provenance,
    );
    expect(checked.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'code_source',
        stepId: 'calculate',
        field: 'source',
      }),
    );
  });
});
