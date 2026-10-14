import { randomUUID } from 'node:crypto';

import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import {
  createExceptionClient,
  createExceptionWorker,
} from '@luma/workflow-temporal';
import { context as otelContext, propagation, trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { expect, it } from 'vitest';

it('propagates an API span through a real Temporal client, workflow and activity', async () => {
  const exporter = new InMemorySpanExporter();
  const spanProcessor = new SimpleSpanProcessor(exporter);
  const resource = resourceFromAttributes({ 'service.name': 'local-test' });
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [spanProcessor],
  });
  provider.register();
  const env = await TestWorkflowEnvironment.createLocal();
  const settings = {
    address: env.address,
    namespace: 'default',
    taskQueue: randomUUID(),
    dataRegion: 'AU' as const,
    telemetry: { resource, spanProcessor },
  };
  const tenant = makeTenantContext(
    { userId: 'requester', sessionId: 'session' },
    {
      id: 'tenant',
      name: 'Fixture',
      slug: 'fixture',
      dataRegion: 'AU',
      status: 'active',
    },
    builtInMembership(
      { id: 'membership', organizationId: 'tenant', userId: 'requester' },
      'owner',
    ),
    randomUUID(),
  );
  const client = await createExceptionClient(settings, {
    refreshContext: async (value) => value,
  });
  const worker = await createExceptionWorker(settings, {
    detect: async () => {
      return trace
        .getTracer('test')
        .startActiveSpan('database.inside.activity', (span) => {
          span.end();

          return null;
        });
    },
    diagnose: async () => {
      throw new Error('Unexpected diagnosis');
    },
    propose: async () => null,
    execute: async () => ({ state: 'succeeded' }),
    reconcile: async () => ({ state: 'succeeded' }),
    verify: async () => true,
  });
  const running = worker.run();
  try {
    let traceId = '';
    await provider
      .getTracer('test')
      .startActiveSpan('api.request', async (span) => {
        traceId = span.spanContext().traceId;
        try {
          const { workflowId } = await client.start(tenant, {
            kind: 'incident',
            id: 'fixture',
          });
          expect(
            await env.client.workflow.getHandle(workflowId).result(),
          ).toEqual({ phase: 'no_incident' });
        } finally {
          span.end();
        }
      });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    for (const name of [
      'StartWorkflow:exceptionWorkflow',
      'RunWorkflow:exceptionWorkflow',
      'RunActivity:detect',
      'database.inside.activity',
    ]) {
      const span = spans.find((entry) => entry.name === name);
      expect(span, name).toBeDefined();
      expect(span?.spanContext().traceId, name).toBe(traceId);
    }
    const activity = spans.find((span) => span.name === 'RunActivity:detect')!;
    expect(
      spans.find((span) => span.name === 'database.inside.activity')
        ?.parentSpanContext?.spanId,
    ).toBe(activity.spanContext().spanId);
  } finally {
    worker.shutdown();
    await running;
    await worker.close();
    await client.close();
    await env.teardown();
    await provider.shutdown();
    trace.disable();
    otelContext.disable();
    propagation.disable();
  }
}, 60000);
