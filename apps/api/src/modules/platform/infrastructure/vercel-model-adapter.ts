import { z } from 'zod';
import { ModelGatewayError } from '#modules/platform/application/model-gateway';
import type {
  JsonValue,
  ModelAdapter,
  ModelMessage,
} from '#modules/platform/application/model-gateway';

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.enum(['stop', 'tool_calls']),
        message: z.object({
          content: z.string().nullish(),
          refusal: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal('function'),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .length(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }),
});

function message(value: ModelMessage) {
  if (value.role === 'tool')
    return { role: 'tool', tool_call_id: value.callId, content: value.content };
  if (value.role === 'assistant')
    return {
      role: value.role,
      content: value.content,
      ...(value.toolCalls?.length
        ? {
            tool_calls: value.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }
        : {}),
    };
  return { role: value.role, content: value.content };
}

/** Fixed destination and disabled redirects prevent credential or payload forwarding. */
export function createVercelModelAdapter(
  settings: { apiKey: string; timeoutMs: number },
  transport: typeof fetch = fetch,
): ModelAdapter {
  return {
    region: 'unrestricted',
    supportsZeroDataRetention: true,
    async generate(route, request) {
      const timeout = AbortSignal.timeout(settings.timeoutMs);
      const signal = request.signal
        ? AbortSignal.any([timeout, request.signal])
        : timeout;
      try {
        const response = await transport(
          'https://ai-gateway.vercel.sh/v1/chat/completions',
          {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
              Authorization: `Bearer ${settings.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: route.model,
              messages: request.messages.map(message),
              stream: false,
              max_tokens: request.maxOutputTokens,
              providerOptions: {
                gateway: {
                  only: route.providers,
                  zeroDataRetention: route.zeroDataRetention,
                },
              },
              ...(request.output
                ? {
                    response_format: {
                      type: 'json_schema',
                      json_schema: {
                        name: request.output.name,
                        strict: true,
                        schema: request.output.jsonSchema,
                      },
                    },
                  }
                : {}),
              ...(request.tools?.length
                ? {
                    tools: request.tools.map((tool) => ({
                      type: 'function',
                      function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.input.jsonSchema,
                        strict: true,
                      },
                    })),
                    tool_choice: 'auto',
                  }
                : {}),
            }),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new ModelGatewayError(
            response.status === 429 ? 'rate_limited' : 'provider_error',
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
        const choice = parsed.data.choices[0]!;
        const calls = choice.message.tool_calls ?? [];
        const hasToolCalls = calls.length > 0;
        if (
          choice.message.refusal ||
          (choice.finish_reason === 'tool_calls') !== hasToolCalls ||
          (!hasToolCalls && choice.message.content == null)
        )
          throw new ModelGatewayError('invalid_output');
        let toolCalls;
        try {
          toolCalls = calls.map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: JSON.parse(call.function.arguments) as JsonValue,
          }));
        } catch {
          throw new ModelGatewayError('invalid_output');
        }
        return {
          text: choice.message.content ?? '',
          toolCalls,
          usage: {
            inputTokens: parsed.data.usage.prompt_tokens,
            outputTokens: parsed.data.usage.completion_tokens,
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
