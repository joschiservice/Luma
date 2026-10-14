// Starts the real API with an EU authoring route. Only Bedrock HTTPS calls are intercepted;
// signing, account checks, routing, validation, persistence and HTTP are real.
import { authoringModel, describedDraft } from './authoring-fixture.mjs';

function answer(body) {
  const request = JSON.stringify(body);
  const refund = request.includes('refund');
  const refining = request.includes('Current draft:');
  const content = refining
    ? {
        ...describedDraft,
        steps: [
          { id: 'settle', kind: 'wait', seconds: 600 },
          ...describedDraft.steps,
        ],
      }
    : refund
      ? {
          ...describedDraft,
          steps: describedDraft.steps.map((step) =>
            step.kind === 'capability'
              ? { ...step, capability: 'payments.refund.create' }
              : step,
          ),
        }
      : describedDraft;

  return {
    content,
    steps: [
      {
        stepId: 'create-order',
        explanation: 'Drafts a purchase order for the supplier.',
      },
    ],
    assumptions: ['The usual supplier is the one set for this stock position.'],
    questions: [
      {
        stepId: 'create-order',
        field: 'parameters.quantity',
        question: 'Should the quantity come from the replenishment proposal?',
      },
    ],
  };
}

const passthrough = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (!url.hostname.endsWith('.amazonaws.com')) return passthrough(input, init);
  if (url.pathname === '/data-retention')
    return Response.json({ mode: 'none' });
  if (url.pathname === '/logging/modelinvocations') return Response.json({});
  if (url.pathname.startsWith('/inference-profiles/'))
    return Response.json({
      models: [
        {
          modelArn:
            'arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
        },
      ],
    });
  const body = JSON.parse(String(init.body));
  const name = body.toolConfig.tools[0].toolSpec.name;

  return Response.json({
    output: {
      message: {
        role: 'assistant',
        content: [
          { toolUse: { toolUseId: 'output-1', name, input: answer(body) } },
        ],
      },
    },
    stopReason: 'tool_use',
    usage: { inputTokens: 120, outputTokens: 80 },
  });
};

Object.assign(process.env, {
  LOG_LEVEL: 'info',
  MODEL_GATEWAY_ROUTES: JSON.stringify({
    authoring: {
      adapter: 'bedrock',
      model: authoringModel,
      providers: ['bedrock'],
      zeroDataRetention: true,
    },
  }),
  MODEL_GATEWAY_BEDROCK_REGION: 'ap-southeast-2',
  MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID: 'AKIAEXAMPLEE2E00001',
  MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY: 'e2e-secret-access-key',
});

const { main } = await import('../dist/index.js');
await main();
