import type { Permission, TenantContext } from '@luma/identity';
import { hasPermission, IdentityError } from '@luma/identity';
import type { JsonValue, ModelTool } from '@luma/platform';

import {
  boundResult,
  citationMarker,
  type RecordKind,
  type RecordReference,
} from '../domain/answer.js';

/** What a read returns: data for the model and the records it may cite. */
export interface ToolOutput {
  /** JSON-serializable. */
  data: unknown;
  records: RecordReference[];
}

/**
 * A read-only assistant tool. Handlers receive a freshly authorized tenant context and call
 * owning application services or read models; they never write.
 */
export interface AssistantTool<Input = unknown> {
  /** Stable name the model calls. */
  readonly name: string;
  /** Shown to people when a call can't be described, for example "Search orders". */
  readonly label: string;
  /** Written for the model: what the tool reads and when to use it. */
  readonly description: string;
  /** The record kind this tool reads, reported by availability. */
  readonly reads: RecordKind;
  /** The read permission a person needs before the model is offered this tool. */
  readonly permission: Permission;
  readonly jsonSchema: Readonly<Record<string, JsonValue>>;
  /** Validates arguments, returning field problems the model can correct. */
  parse(value: unknown): { input: Input } | { problems: string[] };
  /** A short, human-readable description of a call, shown with the answer. */
  describe(input: Input): string;
  run(context: TenantContext, input: Input): Promise<ToolOutput>;
}

/** Declares a tool whose handlers receive the input type its parser produces. */
export function defineTool<Input>(
  parse: AssistantTool<Input>['parse'],
  tool: Omit<AssistantTool<Input>, 'parse'>,
): AssistantTool {
  return { ...tool, parse } as AssistantTool;
}

export type StepOutcome =
  'ok' | 'invalid_arguments' | 'not_found' | 'failed' | 'skipped';

/** The result of one call: the text the model reads and what the person sees. */
export interface ToolExecution {
  content: string;
  records: RecordReference[];
  step: {
    tool: string;
    summary: string;
    outcome: StepOutcome;
    records: number;
  };
}

const validName = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Holds the assistant's read-only tools. The model sees the name, description and JSON Schema of
 * each tool the person's permissions allow. Arguments are validated here rather than by the
 * gateway, so a mistake comes back to the model as a correctable tool result instead of failing
 * the whole answer.
 */
export function createToolRegistry(
  tools: readonly AssistantTool[],
  maxResultLength = 12_000,
) {
  const byName = new Map<string, AssistantTool>();
  for (const tool of tools) {
    if (!validName.test(tool.name) || byName.has(tool.name))
      throw new Error(`Invalid or duplicate assistant tool: ${tool.name}`);
    byName.set(tool.name, tool);
  }

  const declare = (tool: AssistantTool): ModelTool => ({
    name: tool.name,
    description: tool.description,
    input: {
      name: tool.name,
      jsonSchema: tool.jsonSchema,
      // Any JSON object reaches `execute`, which reports invalid arguments to the model.
      parse: (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Tool arguments must be an object');

        return value;
      },
    },
  });
  const permitted = (context: TenantContext) =>
    tools.filter((tool) => hasPermission(context, tool.permission));

  const result = (
    tool: string,
    summary: string,
    outcome: StepOutcome,
    data: unknown,
    records: RecordReference[] = [],
  ): ToolExecution => ({
    content: boundResult(data, maxResultLength),
    records,
    step: { tool, summary, outcome, records: records.length },
  });

  return {
    /** Tool declarations for the model, limited to tools the refreshed context may use. */
    declarations: (context: TenantContext): ModelTool[] =>
      permitted(context).map(declare),
    /** Record kinds the refreshed context can read through the assistant. */
    reads: (context: TenantContext): RecordKind[] => [
      ...new Set(permitted(context).map((tool) => tool.reads)),
    ],

    /**
     * Runs one call with a context the caller has just refreshed. Calls to tools the context
     * may not use are refused without reading. Authorization failures from reads are rethrown so
     * the whole answer stops; other failures become results the model can explain.
     */
    async execute(
      context: TenantContext,
      call: { name: string; arguments: JsonValue },
    ): Promise<ToolExecution> {
      const tool = byName.get(call.name);
      if (!tool)
        return result(call.name, call.name, 'failed', {
          error: 'unknown_tool',
          message: 'This tool does not exist.',
        });
      if (!hasPermission(context, tool.permission))
        return result(tool.name, tool.label, 'failed', {
          error: 'not_permitted',
          message:
            'This person’s role does not allow this read. Answer without it and say what you could not check.',
        });

      const parsed = tool.parse(call.arguments);
      if ('problems' in parsed)
        return result(tool.name, tool.label, 'invalid_arguments', {
          error: 'invalid_arguments',
          message:
            'These arguments do not match the tool’s input schema. Fix them and call the tool again.',
          problems: parsed.problems,
        });
      const { input } = parsed;
      const summary = tool.describe(input);

      try {
        const output = await tool.run(context, input);
        const content = boundResult(output.data, maxResultLength);
        // Only records that survived bounding were shown to the model, so only they are citable.
        const records = output.records.filter((record) =>
          content.includes(citationMarker(record.kind, record.id)),
        );

        return {
          content,
          records,
          step: {
            tool: tool.name,
            summary,
            outcome: 'ok',
            records: records.length,
          },
        };
      } catch (error) {
        if (
          error instanceof IdentityError &&
          (error.statusCode === 401 || error.statusCode === 403)
        )
          throw error;
        if (error instanceof IdentityError && error.statusCode === 404)
          return result(tool.name, summary, 'not_found', {
            error: 'not_found',
            message: 'No record with this ID exists in this workspace.',
          });
        if (exposedBadRequest(error))
          return result(tool.name, summary, 'invalid_arguments', {
            error: 'invalid_arguments',
            message: error.message,
          });

        return result(tool.name, summary, 'failed', {
          error: 'read_failed',
          message:
            'This read failed. Tell the person the data could not be read right now.',
        });
      }
    },
  };
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;

/** Read models reject stale cursors with a 400 error whose message is written for people. */
function exposedBadRequest(error: unknown): error is Error {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    error.statusCode === 400 &&
    'expose' in error &&
    error.expose === true
  );
}
