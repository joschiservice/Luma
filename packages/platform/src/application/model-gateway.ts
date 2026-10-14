import type { Observability, TraceContext } from './observability.js';

export type DataRegion = 'EU' | 'AU' | 'US';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Supply a JSON Schema and a matching runtime parser; neither is sent to telemetry. */
export interface ModelSchema<T> {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, JsonValue>>;
  parse(value: unknown): T;
}

export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly input: ModelSchema<unknown>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonValue;
}

export type ModelMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly ModelToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly callId: string;
      readonly content: string;
    };

/** Set from trusted application policy after authorization, not from user input. */
export interface ModelDataPolicy {
  readonly classification: 'public' | 'sensitive';
  readonly region: DataRegion | 'unrestricted';
  readonly zeroDataRetention: boolean;
}

export interface ModelRequest<T = string> {
  readonly profile: string;
  readonly dataPolicy: ModelDataPolicy;
  readonly messages: readonly ModelMessage[];
  readonly output?: ModelSchema<T>;
  readonly tools?: readonly ModelTool[];
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** USD reported by the provider; null means unavailable, not free. */
  readonly costUsd: number | null;
}

interface ModelResult<T> {
  readonly output: T | null;
  /** Proposals only. The caller must authorize and execute them through execution. */
  readonly toolCalls: readonly ModelToolCall[];
  readonly metadata: ModelUsage & {
    readonly adapter: ModelAdapterId;
    readonly model: string;
    readonly latencyMs: number;
  };
}

export interface ModelGateway {
  generate<T = string>(
    context: TraceContext,
    request: ModelRequest<T>,
  ): Promise<ModelResult<T>>;
}

export type ModelAdapterId = 'vercel' | 'bedrock';

/**
 * Profile for natural-language workflow authoring. Authoring prompts contain tenant data, so
 * send them as `sensitive` with the authorized tenant region and route this profile to a regional zero-retention
 * route such as `bedrock`.
 */
export const authoringModelProfile = 'authoring';

export interface ModelRoute {
  readonly adapter: ModelAdapterId;
  readonly model: string;
  readonly providers: readonly string[];
  readonly zeroDataRetention: boolean;
}

/** Policy may select an existing route or deny it; it cannot invent a destination. */
export type ModelRoutingPolicy = (
  request: Pick<ModelRequest, 'profile' | 'dataPolicy'>,
  routes: Readonly<Record<string, ModelRoute>>,
) => string | null;

export interface ModelAdapter {
  /** Covers gateway ingress, processing and provider inference. */
  readonly region: DataRegion | 'unrestricted';
  readonly supportsZeroDataRetention: boolean;
  generate(
    route: ModelRoute,
    request: ModelRequest<unknown>,
  ): Promise<{
    readonly text: string;
    readonly toolCalls: readonly ModelToolCall[];
    readonly usage: ModelUsage;
  }>;
}

export type ModelErrorCode =
  | 'route_denied'
  | 'adapter_unavailable'
  | 'invalid_request'
  | 'invalid_output'
  | 'provider_error'
  | 'rate_limited'
  | 'timeout'
  | 'aborted';

export class ModelGatewayError extends Error {
  constructor(readonly code: ModelErrorCode) {
    super(`Model generation failed: ${code}`);
    this.name = 'ModelGatewayError';
  }
}

/**
 * Routes model requests through approved profiles, enforcing input policy, structured output
 * validation, and telemetry boundaries.
 */
export function createRoutedModelGateway(
  routes: Readonly<Record<string, ModelRoute>>,
  adapters: Readonly<Partial<Record<ModelAdapterId, ModelAdapter>>>,
  observability: Observability,
  now: () => number,
  policy: ModelRoutingPolicy = (request) => request.profile,
): ModelGateway {
  // Snapshot trusted configuration so a policy callback cannot relax later requests.
  const configured = Object.freeze(
    Object.fromEntries(
      Object.entries(routes).map(([key, route]) => [
        key,
        Object.freeze({
          ...route,
          providers: Object.freeze([...route.providers]),
        }),
      ]),
    ),
  );

  return {
    async generate<T = string>(
      context: TraceContext,
      request: ModelRequest<T>,
    ): Promise<ModelResult<T>> {
      return observability.run(
        context,
        'model.generate',
        async (_context, observation) => {
          if (request.signal?.aborted) throw new ModelGatewayError('aborted');
          if (
            !request.messages.length ||
            !Number.isSafeInteger(request.maxOutputTokens) ||
            request.maxOutputTokens < 1 ||
            request.maxOutputTokens > 32768
          )
            throw new ModelGatewayError('invalid_request');
          const selected = policy(
            {
              profile: request.profile,
              dataPolicy: Object.freeze({ ...request.dataPolicy }),
            },
            configured,
          );
          const route =
            selected && Object.hasOwn(configured, selected)
              ? configured[selected]
              : undefined;
          if (!route) throw new ModelGatewayError('route_denied');
          const adapter = adapters[route.adapter];
          if (!adapter) throw new ModelGatewayError('adapter_unavailable');
          const data = request.dataPolicy;
          if (
            !['public', 'sensitive'].includes(data.classification) ||
            !['EU', 'AU', 'US', 'unrestricted'].includes(data.region) ||
            typeof data.zeroDataRetention !== 'boolean' ||
            (data.classification === 'sensitive' &&
              data.region === 'unrestricted') ||
            (data.region !== 'unrestricted' &&
              adapter.region !== data.region) ||
            ((data.zeroDataRetention || data.classification === 'sensitive') &&
              !route.zeroDataRetention) ||
            (route.zeroDataRetention && !adapter.supportsZeroDataRetention)
          )
            throw new ModelGatewayError('route_denied');
          const tools = request.tools ?? [];
          const validName = (name: string) =>
            /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);
          if (
            new Set(tools.map((tool) => tool.name)).size !== tools.length ||
            tools.some((tool) => !validName(tool.name)) ||
            (request.output && !validName(request.output.name))
          )
            throw new ModelGatewayError('invalid_request');
          validateToolHistory(request.messages, tools);
          const started = now();
          try {
            const result = await adapter.generate(route, request);
            const latencyMs = Math.max(0, now() - started);
            if (
              !Number.isFinite(latencyMs) ||
              ![result.usage.inputTokens, result.usage.outputTokens].every(
                (n) => Number.isSafeInteger(n) && n >= 0,
              ) ||
              (result.usage.costUsd !== null &&
                (!Number.isFinite(result.usage.costUsd) ||
                  result.usage.costUsd < 0))
            )
              throw new ModelGatewayError('invalid_output');
            observation.generation({
              model: route.model,
              ...result.usage,
              latencyMs,
            });
            let output: T | null = null;
            try {
              if (result.toolCalls.length) {
                const ids = new Set<string>();
                for (const call of result.toolCalls) {
                  const tool = tools.find((item) => item.name === call.name);
                  if (!call.id || ids.has(call.id) || !tool) throw new Error();
                  ids.add(call.id);
                  tool.input.parse(call.arguments);
                }
              } else {
                output = request.output
                  ? request.output.parse(JSON.parse(result.text))
                  : (result.text as T);
              }
            } catch {
              throw new ModelGatewayError('invalid_output');
            }

            return {
              output,
              toolCalls: result.toolCalls,
              metadata: {
                ...result.usage,
                adapter: route.adapter,
                model: route.model,
                latencyMs,
              },
            };
          } catch (error) {
            if (error instanceof ModelGatewayError) throw error;
            // Provider exceptions can contain prompts, credentials and response bodies.
            throw new ModelGatewayError('provider_error');
          }
        },
      );
    },
  };
}

/** Each assistant tool batch must receive one result per call before another turn. */
function validateToolHistory(
  messages: readonly ModelMessage[],
  tools: readonly ModelTool[],
): void {
  const declared = new Map(tools.map((tool) => [tool.name, tool]));
  const seen = new Set<string>();
  const pending = new Set<string>();
  try {
    for (const message of messages) {
      if (message.role === 'tool') {
        if (!pending.delete(message.callId)) throw new Error();
        continue;
      }
      if (pending.size) throw new Error();
      if (message.role !== 'assistant') continue;
      for (const call of message.toolCalls ?? []) {
        const tool = declared.get(call.name);
        if (!call.id.trim() || seen.has(call.id) || !tool) throw new Error();
        tool.input.parse(call.arguments);
        seen.add(call.id);
        pending.add(call.id);
      }
    }
    if (pending.size) throw new Error();
  } catch {
    // Schema parser errors may include historical tool arguments.
    throw new ModelGatewayError('invalid_request');
  }
}
