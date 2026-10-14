import { z } from 'zod';

import type {
  DataRegion,
  JsonValue,
  ModelAdapter,
  ModelMessage,
  ModelRequest,
} from '../application/model-gateway.js';
import { ModelGatewayError } from '../application/model-gateway.js';
import type { AwsCredentials } from './aws-signature.js';
import { signAwsRequest } from './aws-signature.js';

/** Allowed AWS destinations for each jurisdiction; a profile must stay entirely within it. */
export const bedrockRegionalAwsRegions: Readonly<
  Record<DataRegion, readonly string[]>
> = {
  EU: [
    'eu-central-1',
    'eu-north-1',
    'eu-south-1',
    'eu-south-2',
    'eu-west-1',
    'eu-west-3',
  ],
  AU: ['ap-southeast-2', 'ap-southeast-4'],
  US: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
};

export interface BedrockSettings {
  readonly region: string;
  readonly dataRegion?: DataRegion;
  readonly credentials: AwsCredentials;
  /** Bounds the whole call, including retention checks and reading the response. */
  readonly timeoutMs: number;
  /** How long a successful retention and routing check is reused; defaults to 5 minutes. */
  readonly verificationIntervalMs?: number;
}

// Leading segments of cross-region inference profiles that can leave the cell jurisdiction.
const geographies = new Set([
  'global',
  'us',
  'us-gov',
  'apac',
  'jp',
  'au',
  'ca',
  'eu',
]);

// A bare foundation model ID (`provider.model`) runs in the configured region. An `eu.`
// system inference profile routes within its listed destination regions. ARNs, application
// inference profiles and other geographies are rejected.
const modelPattern =
  /^(?:(eu|au|us)\.)?([a-z0-9-]+)\.[a-z0-9-]+(?::[a-z0-9-]+)*$/;

// Only `none` guarantees that AWS stores no inputs or outputs; AWS then rejects models that
// require retention. `inherit` and `default` fall back to each model's own policy.
const retentionSchema = z.object({ mode: z.literal('none') });

const loggingSchema = z.object({
  loggingConfig: z
    .object({ textDataDeliveryEnabled: z.boolean().optional() })
    .catchall(z.unknown())
    .nullish(),
});

const profileSchema = z.object({
  models: z.array(z.object({ modelArn: z.string() })).min(1),
});

const blockSchema = z.union([
  z.object({ text: z.string() }).strict(),
  z
    .object({
      toolUse: z.object({
        toolUseId: z.string().min(1),
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
      }),
    })
    .strict(),
]);

const responseSchema = z.object({
  output: z.object({
    message: z.object({
      role: z.literal('assistant'),
      content: z.array(blockSchema),
    }),
  }),
  // Truncated, filtered, guardrail-blocked and malformed outputs use other stop reasons.
  stopReason: z.enum(['end_turn', 'tool_use']),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
});

/**
 * Creates the Amazon Bedrock adapter for regional processing with zero data retention. Calls use
 * the Converse API on the configured regional regional endpoint and never fall back to another
 * region. Before inference, and again after each verification interval, the adapter reads
 * the account's data retention mode, its model invocation logging configuration and the
 * destination regions of `eu.` inference profiles. It fails closed with
 * `adapter_unavailable` unless retention is `none` and invocation logging excludes payloads,
 * or when a check fails. It fails with `route_denied` when a model ID or profile destination
 * could leave the cell jurisdiction. Throws at construction for a mismatched region or missing credentials.
 */
export function createBedrockModelAdapter(
  settings: BedrockSettings,
  transport: typeof fetch = fetch,
  now: () => number = () => Date.now(),
): ModelAdapter {
  const dataRegion =
    settings.dataRegion ??
    (Object.entries(bedrockRegionalAwsRegions).find(([, regions]) =>
      regions.includes(settings.region),
    )?.[0] as DataRegion | undefined);
  if (
    !dataRegion ||
    !bedrockRegionalAwsRegions[dataRegion].includes(settings.region)
  )
    throw new Error('Bedrock region must match the cell jurisdiction');
  const allowedRegions = bedrockRegionalAwsRegions[dataRegion];
  if (
    !settings.credentials.accessKeyId ||
    !settings.credentials.secretAccessKey
  )
    throw new Error('Bedrock credentials are required');

  const runtimeOrigin = `https://bedrock-runtime.${settings.region}.amazonaws.com`;
  const controlOrigin = `https://bedrock.${settings.region}.amazonaws.com`;
  const interval = settings.verificationIntervalMs ?? 300_000;
  const verifiedAt = new Map<string, number>();

  function send(url: string, signal: AbortSignal, body?: string) {
    const method = body === undefined ? 'GET' : 'POST';
    const content =
      body === undefined
        ? {}
        : { body, headers: { 'content-type': 'application/json' } };

    return transport(url, {
      method,
      redirect: 'error',
      signal,
      ...(body === undefined ? {} : { body }),
      headers: signAwsRequest({
        method,
        url: new URL(url),
        ...content,
        service: 'bedrock',
        region: settings.region,
        credentials: settings.credentials,
        date: new Date(now()),
        signPayloadHash: true,
      }),
    });
  }

  async function readControlPlane(path: string, signal: AbortSignal) {
    const response = await send(`${controlOrigin}${path}`, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelGatewayError('adapter_unavailable');
    }

    return response.json() as Promise<unknown>;
  }

  function isFresh(key: string) {
    const at = verifiedAt.get(key);

    return at !== undefined && now() - at < interval;
  }

  async function verify(model: string, profile: boolean, signal: AbortSignal) {
    try {
      if (!isFresh('account')) {
        const retention = retentionSchema.safeParse(
          await readControlPlane('/data-retention', signal),
        );
        if (!retention.success)
          throw new ModelGatewayError('adapter_unavailable');
        const logging = loggingSchema.safeParse(
          await readControlPlane('/logging/modelinvocations', signal),
        );
        if (!logging.success || deliversPayloads(logging.data.loggingConfig))
          throw new ModelGatewayError('adapter_unavailable');
        verifiedAt.set('account', now());
      }
      if (profile && !isFresh(`profile:${model}`)) {
        const destinations = profileSchema.safeParse(
          await readControlPlane(
            `/inference-profiles/${encodeURIComponent(model)}`,
            signal,
          ),
        );
        if (!destinations.success)
          throw new ModelGatewayError('adapter_unavailable');
        if (
          !destinations.data.models.every(({ modelArn }) =>
            allowedRegions.includes(
              /^arn:aws:bedrock:([a-z0-9-]+):/.exec(modelArn)?.[1] ?? '',
            ),
          )
        )
          throw new ModelGatewayError('route_denied');
        verifiedAt.set(`profile:${model}`, now());
      }
    } catch (error) {
      if (error instanceof ModelGatewayError) throw error;
      throw new ModelGatewayError('adapter_unavailable');
    }
  }

  return {
    region: dataRegion,
    supportsZeroDataRetention: true,
    async generate(route, request) {
      const model = modelPattern.exec(route.model);
      if (
        !model ||
        geographies.has(model[2]!) ||
        (model[1] && model[1] !== dataRegion.toLowerCase())
      )
        throw new ModelGatewayError('route_denied');
      const outputName = request.output?.name;
      if (request.tools?.some((tool) => tool.name === outputName))
        throw new ModelGatewayError('invalid_request');

      const timeout = AbortSignal.timeout(settings.timeoutMs);
      const signal = request.signal
        ? AbortSignal.any([timeout, request.signal])
        : timeout;
      try {
        await verify(route.model, !!model[1], signal);
        const response = await send(
          `${runtimeOrigin}/model/${encodeURIComponent(route.model)}/converse`,
          signal,
          JSON.stringify(converseRequest(request)),
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new ModelGatewayError(
            response.status === 429 ||
              /(^|#)ThrottlingException(:|,|$)/.test(
                response.headers.get('x-amzn-errortype') ?? '',
              )
              ? 'rate_limited'
              : 'provider_error',
          );
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new ModelGatewayError('invalid_output');
        }
        const parsed = responseSchema.safeParse(body);
        if (!parsed.success) throw new ModelGatewayError('invalid_output');

        const blocks = parsed.data.output.message.content;
        const texts = blocks.flatMap((block) =>
          'text' in block ? [block.text] : [],
        );
        const uses = blocks.flatMap((block) =>
          'toolUse' in block ? [block.toolUse] : [],
        );
        const outputs = uses.filter((use) => use.name === outputName);
        const calls = uses.filter((use) => use.name !== outputName);
        const usedTools = uses.length > 0;
        if (
          (parsed.data.stopReason === 'tool_use') !== usedTools ||
          (outputs.length > 0 && (outputs.length > 1 || calls.length > 0)) ||
          (!usedTools && (outputName !== undefined || !texts.length))
        )
          throw new ModelGatewayError('invalid_output');

        return {
          // Structured output arrives as the input of the forced output tool.
          text: outputs.length
            ? JSON.stringify(outputs[0]!.input)
            : texts.join(''),
          toolCalls: calls.map((call) => ({
            id: call.toolUseId,
            name: call.name,
            arguments: call.input as JsonValue,
          })),
          usage: {
            inputTokens: parsed.data.usage.inputTokens,
            outputTokens: parsed.data.usage.outputTokens,
            costUsd: null,
          },
        };
      } catch (error) {
        if (request.signal?.aborted) throw new ModelGatewayError('aborted');
        if (timeout.aborted) throw new ModelGatewayError('timeout');
        if (error instanceof ModelGatewayError) throw error;
        throw new ModelGatewayError('provider_error');
      }
    },
  };
}

/**
 * Metadata-only invocation logging is allowed. Text logging must be explicitly disabled, and
 * no other payload type may be delivered.
 */
function deliversPayloads(
  config: z.infer<typeof loggingSchema>['loggingConfig'],
): boolean {
  if (!config) return false;

  return (
    config.textDataDeliveryEnabled !== false ||
    Object.entries(config).some(
      ([key, value]) => key.endsWith('DataDeliveryEnabled') && value !== false,
    )
  );
}

function converseRequest(request: ModelRequest<unknown>) {
  const output = request.output;
  const tools = [
    ...(request.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.input.jsonSchema,
    })),
    ...(output
      ? [
          {
            name: output.name,
            description: 'Return the final response in this structure.',
            schema: output.jsonSchema,
          },
        ]
      : []),
  ];
  const system = request.messages.flatMap((message) =>
    message.role === 'system' && message.content
      ? [{ text: message.content }]
      : [],
  );

  return {
    messages: converseMessages(request.messages),
    ...(system.length ? { system } : {}),
    inferenceConfig: { maxTokens: request.maxOutputTokens },
    ...(tools.length
      ? {
          toolConfig: {
            tools: tools.map((tool) => ({
              toolSpec: {
                name: tool.name,
                ...(tool.description ? { description: tool.description } : {}),
                inputSchema: { json: tool.schema },
              },
            })),
            // Structured output forces the output tool, or any tool when others are declared.
            toolChoice: !output
              ? { auto: {} }
              : request.tools?.length
                ? { any: {} }
                : { tool: { name: output.name } },
          },
        }
      : {}),
  };
}

/**
 * Converse accepts only alternating user and assistant turns, so tool results become user
 * content and consecutive turns with the same role are merged.
 */
function converseMessages(messages: readonly ModelMessage[]) {
  const turns: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: unknown[] =
      message.role === 'tool'
        ? [
            {
              toolResult: {
                toolUseId: message.callId,
                content: [{ text: message.content }],
              },
            },
          ]
        : [
            ...(message.content ? [{ text: message.content }] : []),
            ...(message.role === 'assistant'
              ? (message.toolCalls ?? []).map((call) => ({
                  toolUse: {
                    toolUseId: call.id,
                    name: call.name,
                    input: call.arguments,
                  },
                }))
              : []),
          ];
    if (!content.length) continue;
    const previous = turns.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else turns.push({ role, content });
  }

  return turns;
}
