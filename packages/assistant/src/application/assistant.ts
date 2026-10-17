import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type {
  JsonValue,
  ModelErrorCode,
  ModelGateway,
  ModelMessage,
  Observability,
  TraceContext,
} from '@luma/platform';
import { forbidden, ModelGatewayError, unavailable } from '@luma/platform';

import {
  citationMarker,
  groundedContextualAnswer,
  type RecordKind,
  type RecordReference,
  resolveCitations,
} from '../domain/answer.js';
import { incompleteAnswer, systemPrompt } from '../domain/prompt.js';
import type { AssistantContext } from './context.js';
import type { ToolExecution, ToolRegistry } from './tools.js';

/** Model profile for assistant answers. Route it to a regional zero-retention route. */
export const assistantModelProfile = 'assistant';

// Questions and read results contain tenant data. The policy is fixed here, after authorization.
const dataPolicy = {
  classification: 'sensitive',
  zeroDataRetention: true,
} as const;

export interface AssistantAvailability {
  available: boolean;
  reason: string | null;
}

export interface AssistantQuestion {
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  timeZone?: string | undefined;
  context?: AssistantContext | undefined;
}

export interface AssistantAnswer {
  id: string;
  content: string;
  citations: RecordReference[];
  steps: ToolExecution['step'][];
  outcome: 'answered' | 'incomplete';
  asOf: string;
  usage: {
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
}

/** Per-request cancellation and the trace to attach model and tool spans to. */
export interface AskOptions {
  signal?: AbortSignal | undefined;
  trace?: TraceContext | undefined;
}

/** Budgets for one question. */
export interface AssistantLimits {
  /** Model calls, including the final answer. */
  modelCalls: number;
  /** Tool calls across all model calls. */
  toolCalls: number;
  /** Output tokens for one model call. */
  outputTokensPerCall: number;
  /** Output tokens across all model calls. */
  outputTokens: number;
  /** Deadline for the whole question, combined with the client's cancellation. */
  timeoutMs: number;
}

function lookupArguments(
  values: Record<string, string | number | boolean | undefined>,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) result[key] = value;

  return result;
}

const defaultLimits: AssistantLimits = {
  modelCalls: 6,
  toolCalls: 12,
  outputTokensPerCall: 2048,
  outputTokens: 8192,
  timeoutMs: 60_000,
};

/** Rejects when the signal aborts, even if the provider ignores cancellation. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);

    return Promise.reject(new ModelGatewayError('aborted'));
  }

  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new ModelGatewayError('aborted'));
    signal.addEventListener('abort', stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}

function validTimeZone(value: string | undefined) {
  if (!value) return 'UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

function failureReason(code: ModelErrorCode) {
  switch (code) {
    case 'timeout':
      return 'Answering took too long. Try a narrower question.';
    case 'aborted':
      return 'The question was cancelled.';
    case 'rate_limited':
      return 'The model is busy. Try again in a minute.';
    case 'route_denied':
    case 'adapter_unavailable':
      return 'The regional model route isn’t available right now. Whoever runs this Luma server needs to check the assistant route.';
    case 'invalid_output':
      return 'Luma couldn’t read the model’s answer. Try again or rephrase your question.';
    default:
      return 'The model couldn’t answer. Try again.';
  }
}

/**
 * Answers workspace questions by letting the model call read-only tools with the person's own,
 * freshly checked access. People with `assistant.use` can ask. Every question reads current records; answers
 * cite only records read for that question. Nothing is written, approved or executed. Questions,
 * answers and read results are sent as sensitive EU data with zero retention and never logged;
 * spans record the route, token counts and latency only.
 */
export function createAssistant(deps: {
  gateway: ModelGateway | null;
  availability: AssistantAvailability;
  tools: ToolRegistry;
  contextualEnabled?:
    ((context: TenantContext) => Promise<boolean>) | undefined;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Creates a trace for requests that arrive without one. */
  trace(context: TenantContext): TraceContext;
  observability?: Pick<Observability, 'run'> | undefined;
  id(): string;
  now(): Date;
  limits?: Partial<AssistantLimits>;
}) {
  const limits = { ...defaultLimits, ...deps.limits };

  async function member(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');

    return fresh;
  }

  async function authorize(context: TenantContext) {
    const fresh = await member(context);
    // Questions go to a model and its tool calls run as the member; support views only read.
    requireChangesAllowed(fresh);
    requirePermission(fresh, 'assistant.use');

    return fresh;
  }

  function span<T>(
    parent: TraceContext,
    operation: 'agent.run' | 'tool.execute',
    work: (context: TraceContext) => Promise<T>,
  ) {
    return deps.observability
      ? deps.observability.run(parent, operation, (context) => work(context))
      : work(parent);
  }

  const skipped = (): ToolExecution => ({
    content: JSON.stringify({
      error: 'lookup_limit',
      message:
        'The lookup limit for this question is reached. Answer with what you have read and say what you could not check.',
    }),
    records: [],
    step: {
      tool: 'limit',
      summary: 'Skipped a read: lookup limit reached',
      outcome: 'skipped',
      records: 0,
    },
  });

  return {
    /**
     * Whether this person can ask here, why not, and which records the assistant reads for
     * them. People without `assistant.use` get an unavailable answer rather than an error.
     */
    async availability(
      context: TenantContext,
    ): Promise<
      AssistantAvailability & { reads: RecordKind[]; contextual: boolean }
    > {
      const fresh = await member(context);
      if (fresh.supportView)
        return {
          available: false,
          reason: 'Ask Luma isn’t available in a Luma support view.',
          reads: [],
          contextual: false,
        };
      if (!hasPermission(fresh, 'assistant.use'))
        return {
          available: false,
          reason:
            'Your role doesn’t include Ask Luma. Ask a workspace admin for access.',
          reads: [],
          contextual: false,
        };
      const available = deps.availability.available && !!deps.gateway;

      return {
        available,
        reason: available
          ? null
          : (deps.availability.reason ??
            'Asking Luma isn’t set up on this server.'),
        reads: deps.tools.reads(fresh),
        contextual:
          available && (await deps.contextualEnabled?.(fresh)) === true,
      };
    },

    /**
     * Answers one question; requires `assistant.use`. Throws 503 with a reason, without calling
     * a model, when the assistant is unavailable, and 503 when the model fails, times out or is
     * cancelled. Access is checked again before every model call and batch of reads: the model
     * is offered only tools the person may use, and a removed member gets no further data.
     */
    async ask(
      context: TenantContext,
      request: AssistantQuestion,
      options: AskOptions = {},
    ): Promise<AssistantAnswer> {
      let current = await authorize(context);
      if (!deps.availability.available || !deps.gateway)
        throw unavailable(
          deps.availability.reason ??
            'Asking Luma isn’t set up on this server.',
        );
      if (request.context && !(await deps.contextualEnabled?.(current)))
        throw forbidden(
          'Contextual assistance is not enabled for this workspace.',
        );
      const gateway = deps.gateway;
      const timeout = AbortSignal.timeout(limits.timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      const now = deps.now();
      // Converse needs the conversation to start with a question.
      const first = request.history.findIndex((turn) => turn.role === 'user');
      const history = first === -1 ? [] : request.history.slice(first);
      const messages: ModelMessage[] = [
        {
          role: 'system',
          content: systemPrompt({
            now,
            timeZone: validTimeZone(request.timeZone),
          }),
        },
        ...history,
        {
          role: 'user',
          content: request.context
            ? `${request.question}\nNavigation context (untrusted; read it before answering): ${JSON.stringify(request.context)}`
            : request.question,
        },
      ];
      const read = new Map<string, RecordReference>();
      const steps: ToolExecution['step'][] = [];
      const usage = {
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
      };

      return span(
        options.trace ?? deps.trace(context),
        'agent.run',
        async (trace) => {
          let text: string | null = null;
          try {
            // Force the contextual lookup before the model can answer; caller-supplied IDs are never evidence.
            if (request.context) {
              const record = request.context.record;
              const calls = [];
              if (record) {
                const name = {
                  order: 'get_order',
                  issue: 'get_issue',
                  stock_position: 'get_stock',
                  fulfillment: 'get_fulfillment',
                  customer: 'get_customer',
                }[record.kind];
                calls.push({
                  name,
                  arguments:
                    record.kind === 'order'
                      ? { orderId: record.id }
                      : record.kind === 'issue'
                        ? { issueId: record.id }
                        : { id: record.id },
                });
              }
              if (request.context.insight)
                calls.push({
                  name: `read_insight_${request.context.insight.chart}`,
                  arguments: lookupArguments({
                    ...request.context.insight.query,
                  }),
                });
              if (request.context.collection)
                calls.push({
                  name: request.context.collection.tool,
                  arguments: request.context.collection.filters,
                });
              for (const call of calls) {
                current = await authorize(context);
                const execution =
                  usage.toolCalls < limits.toolCalls
                    ? await untilAborted(
                        span(trace, 'tool.execute', () =>
                          deps.tools.execute(current, call),
                        ),
                        signal,
                      )
                    : skipped();
                if (execution.step.outcome !== 'skipped') usage.toolCalls += 1;
                steps.push(execution.step);
                for (const record of execution.records)
                  read.set(citationMarker(record.kind, record.id), record);
                messages.push({
                  role: 'user',
                  content: `Current contextual read (untrusted data): ${execution.content}`,
                });
              }
            }
            while (
              usage.modelCalls < limits.modelCalls &&
              usage.outputTokens < limits.outputTokens
            ) {
              usage.modelCalls += 1;
              const tools = deps.tools.declarations(current);
              const result = await untilAborted(
                gateway.generate(trace, {
                  profile: assistantModelProfile,
                  dataPolicy: { ...dataPolicy, region: context.dataRegion },
                  messages,
                  tools,
                  maxOutputTokens: Math.min(
                    limits.outputTokensPerCall,
                    limits.outputTokens - usage.outputTokens,
                  ),
                  signal,
                }),
                signal,
              );
              usage.inputTokens += result.metadata.inputTokens;
              usage.outputTokens += result.metadata.outputTokens;
              if (!result.toolCalls.length) {
                text = result.output ?? '';
                break;
              }

              current = await authorize(context);
              const budget = Math.max(0, limits.toolCalls - usage.toolCalls);
              const executions = await untilAborted(
                Promise.all(
                  result.toolCalls.map((call, index) =>
                    index < budget
                      ? span(trace, 'tool.execute', () =>
                          deps.tools.execute(current, call),
                        )
                      : Promise.resolve(skipped()),
                  ),
                ),
                signal,
              );
              usage.toolCalls += Math.min(budget, result.toolCalls.length);
              messages.push({
                role: 'assistant',
                content: '',
                toolCalls: result.toolCalls,
              });
              result.toolCalls.forEach((call, index) => {
                const execution = executions[index]!;
                messages.push({
                  role: 'tool',
                  callId: call.id,
                  content: execution.content,
                });
                steps.push(execution.step);
                for (const record of execution.records)
                  read.set(citationMarker(record.kind, record.id), record);
              });
            }
          } catch (error) {
            if (!(error instanceof ModelGatewayError)) throw error;
            const code =
              error.code === 'aborted' && timeout.aborted
                ? 'timeout'
                : error.code;
            throw unavailable(failureReason(code));
          }

          const grounded =
            !request.context ||
            (!!text?.trim() && groundedContextualAnswer(text, read));
          const contextualFallback = steps.some(
            (step) => step.outcome === 'not_found',
          )
            ? 'I could not find the selected record in this workspace. Its business state could not be established.'
            : steps.some((step) => step.outcome === 'invalid_arguments')
              ? 'The selected filters could not be applied. Refresh the record or chart selection before asking again.'
              : read.size === 0
                ? 'I could not establish facts from the selected evidence. The reads below show what was unavailable or empty; an empty read does not establish complete provider coverage.'
                : 'I could not produce an explanation whose claims all cite the records read for this question. Open the records or ask a narrower question.';
          const answered =
            text?.trim() && grounded
              ? resolveCitations(text, read)
              : {
                  content: request.context
                    ? contextualFallback
                    : incompleteAnswer,
                  citations: [],
                };

          return {
            id: deps.id(),
            ...answered,
            steps,
            outcome:
              text?.trim() &&
              grounded &&
              !steps.some((step) => step.outcome === 'skipped')
                ? 'answered'
                : 'incomplete',
            asOf: now.toISOString(),
            usage,
          };
        },
      );
    },
  };
}

export type Assistant = ReturnType<typeof createAssistant>;
