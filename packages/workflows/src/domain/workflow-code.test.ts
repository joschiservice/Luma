import { describe, expect, it } from 'vitest';

import { processSource } from './process.fixture.js';
import {
  parseWorkflowSource,
  printWorkflowSource,
  WorkflowCodeError,
} from './workflow-code.js';

const content = {
  schemaVersion: processSource.schemaVersion,
  definition: processSource.definition,
  version: processSource.version,
  applicability: processSource.applicability,
  inputs: processSource.inputs,
  context: processSource.context,
  steps: processSource.steps,
};
const withCode = {
  ...content,
  steps: [
    {
      id: 'calculate',
      kind: 'code',
      source:
        'function main(input, luma) {\n  const note = `total ${input.inputs.quantity}` + "\\\\";\n  return { ready: true };\n}',
      fields: { ready: 'boolean' },
      grants: [],
      limits: {
        fuel: 100_000_000,
        memoryBytes: 67_108_864,
        wallTimeMs: 5000,
        maxRequests: 0,
      },
    },
    ...content.steps,
  ],
};

describe('workflow code view', () => {
  it('prints, parses and prints again byte for byte', () => {
    for (const value of [content, withCode]) {
      const printed = printWorkflowSource(value);
      expect(parseWorkflowSource(printed)).toEqual(value);
      expect(printWorkflowSource(parseWorkflowSource(printed))).toBe(printed);
    }
  });

  it('prints Code Step source as a readable template literal', () => {
    const printed = printWorkflowSource(withCode);
    expect(printed).toContain('source: code`\nfunction main(input, luma) {');
    expect(printed).toContain('\\${input.inputs.quantity}');
  });

  it('accepts comments and formatting but not code', () => {
    expect(
      parseWorkflowSource(
        '// My workflow\nexport default defineWorkflow({ a: 1, "b c": [true, null,], /* note */ })',
      ),
    ).toEqual({ a: 1, 'b c': [true, null] });
    for (const [code, message] of [
      ["import x from 'y';\nexport default defineWorkflow({})", 'Start with'],
      ['export default defineWorkflow({ a: process.env.X })', 'Only literal'],
      ['export default defineWorkflow({ a: `${1}` })', 'Expressions'],
      ['export default defineWorkflow({ a: 1, a: 2 })', 'appears twice'],
      ['export default defineWorkflow({ ...other })', 'property name'],
      ['export default defineWorkflow({});\nrun();', 'Remove everything'],
    ] as const)
      expect(() => parseWorkflowSource(code)).toThrow(message);
  });

  it('reports the line and column of a problem', () => {
    try {
      parseWorkflowSource('export default defineWorkflow({\n  name: nope,\n})');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowCodeError);
      expect(error).toMatchObject({ line: 2, column: 9 });
    }
  });
});
