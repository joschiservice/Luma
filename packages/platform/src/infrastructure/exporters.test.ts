import { randomUUID } from 'node:crypto';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import type { Event } from '@sentry/node';
import { expect, it } from 'vitest';

import { createObservability } from './observability.js';

it('exports the same trace to real Sentry and Langfuse SDKs with safe error metadata', async () => {
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
  telemetry.captureError(root.context);
  root.end('error');
  await telemetry.shutdown();
  const encoded = JSON.stringify(envelopes);
  expect(encoded).toContain('transaction');
  expect(encoded).toContain('Operation failed');
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
