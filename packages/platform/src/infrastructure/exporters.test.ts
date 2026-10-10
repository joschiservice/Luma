import { randomUUID } from 'node:crypto';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import type { Event } from '@sentry/node';
import { expect, it, vi } from 'vitest';

import { createObservability } from './observability.js';

it('exports the same trace to real Sentry and Langfuse SDKs', async () => {
  const envelopes: unknown[] = [];
  const langfuse = new InMemorySpanExporter();
  langfuse.shutdown = async () => {};
  const telemetry = createObservability(
    {
      environment: 'test',
      release: 'test',
      sampleRate: 1,
      sentryDsn: 'https://abc@o1.ingest.de.sentry.io/1',
      langfuse: {
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://cloud.langfuse.com',
      },
    },
    {
      langfuseExporter: langfuse,
      sentryTransport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);

          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    },
  );
  const root = telemetry.request(randomUUID(), randomUUID());
  await telemetry.run(root.context, 'agent.run', async (agent) => {
    await expect(
      telemetry.run(agent, 'tool.execute', async () => {
        throw new Error('private@example.com password-secret');
      }),
    ).rejects.toThrow();
  });
  root.end('error');
  await telemetry.shutdown();
  const encoded = JSON.stringify(envelopes);
  expect(encoded).toContain('transaction');
  expect(encoded).toContain(root.context.traceId);
  expect(encoded).not.toMatch(/private@example.com|password-secret/);
  expect(langfuse.getFinishedSpans()).toHaveLength(3);
  expect(
    langfuse
      .getFinishedSpans()
      .every((span) => span.spanContext().traceId === root.context.traceId),
  ).toBe(true);
});

it('resumes serialized workflow context without losing its trace', async () => {
  const envelopes: unknown[] = [];
  const telemetry = createObservability(
    {
      environment: 'test',
      release: 'test',
      sampleRate: 1,
      sentryDsn: 'https://abc@o1.ingest.de.sentry.io/1',
    },
    {
      sentryTransport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);

          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    },
  );
  const context = {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    requestId: randomUUID(),
  };
  await telemetry.run(context, 'workflow.run', async (workflow) => {
    expect(workflow.traceId).toBe(context.traceId);
    await telemetry.run(workflow, 'agent.run', async () => {});
  });
  await telemetry.shutdown();
  const encoded = JSON.stringify(envelopes);
  expect(encoded).toContain('workflow.run');
  expect(encoded).toContain(context.traceId);
  expect(encoded).toContain(context.spanId);
});

it('keeps all steps unsampled at rate zero and uses safe defaults without exporters', async () => {
  const spans = new InMemorySpanExporter();
  const { SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
  const telemetry = createObservability(
    { environment: 'test', release: 'test', sampleRate: 0 },
    {
      spanProcessors: [new SimpleSpanProcessor(spans)],
    },
  );
  const root = telemetry.request(randomUUID());
  await telemetry.run(root.context, 'agent.run', async () => {});
  root.end();
  expect(spans.getFinishedSpans()).toHaveLength(0);
  expect(await telemetry.flag(root.context, 'observability-test')).toBe(false);
  expect(telemetry.forTenant(root.context, 'tenant', 'EU')).toBe(root.context);
  expect(() =>
    telemetry.captureActivityError(new Error('disabled'), {
      workflowId: 'workflow',
      workflowRunId: 'run',
      activityId: '443',
      activityType: 'refresh',
      attempt: 5,
      taskQueue: 'queue',
      namespace: 'default',
    }),
  ).not.toThrow();
  await telemetry.shutdown();
});

it('exports original activity exceptions and causes with Temporal context at sample rate zero', async () => {
  const envelopes: unknown[] = [];
  const events: Event[] = [];
  const telemetry = createObservability(
    {
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      sentryDsn: 'https://abc@o1.ingest.de.sentry.io/1',
    },
    {
      sentryTransport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);
          events.push(
            ...envelope[1]
              .filter(([header]) => header.type === 'event')
              .map(([, event]) => event as Event),
          );

          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    },
  );
  const context = {
    workflowId: 'exception-v1:abc',
    workflowRunId: randomUUID(),
    activityId: '443',
    activityType: 'refresh',
    attempt: 5,
    taskQueue: 'queue',
    namespace: 'default',
  };
  const error = Object.assign(
    new TypeError('Unable to rebuild proposal', {
      cause: new Error('Provider connection failed'),
    }),
    { payload: 'private-provider-payload' },
  );
  telemetry.captureActivityError(error, context);
  telemetry.captureActivityError(new Error('Second activity failed'), {
    ...context,
    workflowId: 'exception-v1:other',
    activityId: '444',
    attempt: 1,
  });
  await telemetry.shutdown();

  expect(events).toHaveLength(2);
  const first = events.find(
    (event) => event.contexts?.temporal?.activityId === '443',
  )!;
  expect(first.contexts?.temporal).toEqual(context);
  expect(first.exception?.values).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'TypeError',
        value: 'Unable to rebuild proposal',
        stacktrace: { frames: expect.any(Array) },
      }),
      expect.objectContaining({
        type: 'Error',
        value: 'Provider connection failed',
        stacktrace: { frames: expect.any(Array) },
      }),
    ]),
  );
  expect(
    events.find((event) => event.contexts?.temporal?.activityId === '444')
      ?.contexts?.temporal,
  ).toMatchObject({
    workflowId: 'exception-v1:other',
    attempt: 1,
  });
  expect(first).not.toHaveProperty('extra');
  expect(first).not.toHaveProperty('request');
  expect(first).not.toHaveProperty('user');
  expect(JSON.stringify(envelopes)).not.toContain('private-provider-payload');
});

function sentryEvents() {
  const envelopes: unknown[] = [];
  const events: Event[] = [];
  const transport: NonNullable<
    NonNullable<Parameters<typeof createObservability>[1]>['sentryTransport']
  > = () => ({
    send: async (envelope) => {
      envelopes.push(envelope);
      events.push(
        ...envelope[1]
          .filter(([header]) => header.type === 'event')
          .map(([, event]) => event as Event),
      );

      return { statusCode: 200 };
    },
    flush: async () => true,
  });

  return { envelopes, events, transport };
}

it('exports HTTP failures with stack, causes and a redacted request', async () => {
  const { envelopes, events, transport } = sentryEvents();
  const telemetry = createObservability(
    {
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      tenantHashKey: 'a'.repeat(32),
      sentryDsn: 'https://abc@o1.ingest.de.sentry.io/1',
    },
    { sentryTransport: transport },
  );
  const root = telemetry.request(randomUUID(), undefined, {
    route: '/v1/organizations/:organizationId/skus/:skuId',
    method: 'GET',
  });
  const context = telemetry.forTenant(root.context, randomUUID(), 'EU');
  const caseId = randomUUID();
  telemetry.captureError(
    Object.assign(
      new Error('canceling statement due to statement timeout', {
        cause: new Error('Pool query failed'),
      }),
      { code: '57014', detail: 'Key (email)=(private@example.com)' },
    ),
    {
      context,
      request: {
        method: 'GET',
        route: '/v1/organizations/:organizationId/skus/:skuId',
        url: `/v1/organizations/${caseId}/skus/SHIRT-RED?window=24h&q=private-search`,
        headers: {
          cookie: 'session=cookie-secret',
          authorization: 'Bearer bearer-secret',
          'x-forwarded-for': '203.0.113.9',
          'user-agent': 'Vitest',
        },
      },
    },
  );
  await telemetry.shutdown();

  expect(events).toHaveLength(1);
  const [event] = events;
  expect(event?.exception?.values).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: 'canceling statement due to statement timeout',
        stacktrace: { frames: expect.any(Array) },
      }),
      expect.objectContaining({ value: 'Pool query failed' }),
    ]),
  );
  expect(event?.transaction).toBe(
    'GET /v1/organizations/:organizationId/skus/:skuId',
  );
  expect(event?.request).toEqual({
    method: 'GET',
    url: `/v1/organizations/${caseId}/skus/:skuId?window=24h&q=[Filtered]`,
    headers: {
      cookie: '[Filtered]',
      authorization: '[Filtered]',
      'x-forwarded-for': '[Filtered]',
      'user-agent': 'Vitest',
    },
  });
  expect(event?.tags).toMatchObject({
    request_id: context.requestId,
    tenant_ref: context.tenantRef,
    'http.route': '/v1/organizations/:organizationId/skus/:skuId',
  });
  expect(event?.contexts?.trace).toEqual({
    trace_id: context.traceId,
    span_id: context.spanId,
  });
  expect(event).not.toHaveProperty('extra');
  expect(event).not.toHaveProperty('user');
  expect(JSON.stringify(envelopes)).not.toMatch(
    /cookie-secret|bearer-secret|203\.0\.113\.9|private-search|SHIRT-RED|private@example\.com/,
  );
});

it('names background failures by their operation message', async () => {
  const { events, transport } = sentryEvents();
  const telemetry = createObservability(
    {
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      sentryDsn: 'https://abc@o1.ingest.de.sentry.io/1',
    },
    { sentryTransport: transport },
  );
  telemetry.captureError(new Error('Provider timed out'), {
    message: 'Sync pass failed; retrying.',
  });
  await telemetry.shutdown();

  expect(events).toHaveLength(1);
  expect(events[0]?.transaction).toBe('Sync pass failed; retrying.');
  expect(events[0]?.exception?.values?.[0]?.value).toBe('Provider timed out');
  expect(events[0]).not.toHaveProperty('request');
});

it('applies allowed flag overrides without PostHog and rejects unknown ones', async () => {
  const telemetry = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'observability-test': true },
  });
  const root = telemetry.request(randomUUID());
  expect(await telemetry.flag(root.context, 'observability-test')).toBe(true);
  root.end();
  await telemetry.shutdown();

  expect(() =>
    createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      featureFlagOverrides: { 'unlisted-flag': true },
    }),
  ).toThrow('unlisted-flag');
});

function locallyEvaluated(
  status: number,
  environment: 'development' | 'staging' = 'staging',
) {
  const urls: string[] = [];
  const definitions = {
    flags: [
      {
        id: 1,
        key: 'observability-test',
        active: true,
        filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
      },
    ],
    group_type_mapping: {},
    cohorts: {},
  };
  const telemetry = createObservability(
    {
      environment,
      release: 'test',
      sampleRate: 0,
      posthog: {
        apiKey: 'phc_project',
        host: 'https://eu.i.posthog.com',
        secretKey: 'phs_secret',
      },
    },
    {
      posthogFetch: async (url) => {
        urls.push(url);

        return {
          status,
          text: async () => JSON.stringify(definitions),
          json: async () => definitions,
          headers: { get: () => null },
        };
      },
    },
  );

  return { telemetry, urls };
}

/** Only the definitions poll may reach PostHog: no remote evaluation and no flag events. */
function onlyDefinitionPolls(urls: string[]) {
  return urls.every((url) =>
    url.startsWith('https://eu.i.posthog.com/flags/definitions?'),
  );
}

it('evaluates flags from polled definitions without per-check PostHog calls', async () => {
  const { telemetry, urls } = locallyEvaluated(200);
  const root = telemetry.request(randomUUID());
  await vi.waitFor(async () =>
    expect(await telemetry.flag(root.context, 'observability-test')).toBe(true),
  );
  root.end();
  await telemetry.shutdown();
  expect(onlyDefinitionPolls(urls)).toBe(true);
});

it('returns the fallback without calling PostHog when definitions are unavailable', async () => {
  const { telemetry, urls } = locallyEvaluated(503);
  const root = telemetry.request(randomUUID());
  await vi.waitFor(() => expect(urls).toHaveLength(1));
  expect(await telemetry.flag(root.context, 'observability-test')).toBe(false);
  expect(await telemetry.flag(root.context, 'observability-test', true)).toBe(
    true,
  );
  root.end();
  await telemetry.shutdown();
  expect(onlyDefinitionPolls(urls)).toBe(true);
});

it('never asks PostHog for flags in development or test', async () => {
  const { telemetry, urls } = locallyEvaluated(200, 'development');
  const root = telemetry.request(randomUUID());
  expect(await telemetry.flag(root.context, 'observability-test')).toBe(false);
  expect(await telemetry.flag(root.context, 'observability-test', true)).toBe(
    true,
  );
  root.end();
  await telemetry.shutdown();
  expect(urls).toEqual([]);

  const posthog = {
    capture: vi.fn(),
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  const remote = createObservability(
    {
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      posthog: { apiKey: 'phc_project', host: 'https://eu.i.posthog.com' },
    },
    { posthog },
  );
  const request = remote.request(randomUUID());
  expect(await remote.flag(request.context, 'observability-test')).toBe(false);
  request.end();
  await remote.shutdown();
  expect(posthog.isFeatureEnabled).not.toHaveBeenCalled();
});
