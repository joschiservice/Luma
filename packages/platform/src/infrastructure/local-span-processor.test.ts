import { SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { expect, it, vi } from 'vitest';

import {
  localSpanProcessor,
  queryMetadata,
  sanitizeSpan,
} from './local-span-processor.js';

it('exports timings, correlation and exceptions but removes SQL, parameters and URLs', async () => {
  const exporter = new InMemorySpanExporter();
  const record = vi.fn();
  const provider = new NodeTracerProvider({
    spanProcessors: [
      localSpanProcessor(new SimpleSpanProcessor(exporter), () => ({ record })),
    ],
  });
  const span = provider
    .getTracer('@opentelemetry/instrumentation-pg')
    .startSpan('SELECT secret-table');
  span.setAttributes({
    ...queryMetadata('SELECT $1::text'),
    'db.statement': "SELECT 'private@example.com'",
    'db.user': 'secret-user',
    'url.full': 'http://secret',
    'db.query.parameters': ['password'],
  });
  span.recordException(new Error('canceling statement due to timeout'));
  span.addEvent('query', { 'db.statement': 'SELECT secret' });
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: 'canceling statement due to timeout',
  });
  span.end();
  await provider.forceFlush();
  const result = exporter.getFinishedSpans()[0]!;
  expect(result.name).toBe('db.SELECT');
  expect(result.attributes['luma.db.query_id']).toMatch(/^[a-f0-9]{16}$/);
  expect(result.status).toEqual({
    code: SpanStatusCode.ERROR,
    message: 'canceling statement due to timeout',
  });
  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.attributes).toMatchObject({
    'exception.type': 'Error',
    'exception.message': 'canceling statement due to timeout',
    'exception.stacktrace': expect.stringContaining('local-span-processor'),
  });
  expect(JSON.stringify(result.events)).not.toMatch(/secret/);
  expect(JSON.stringify(result.attributes)).not.toMatch(
    /secret|private|password/,
  );
  expect(record).toHaveBeenCalledWith(expect.any(Number), {
    operation: 'db.SELECT',
    status: 'error',
  });
  await provider.shutdown();
});

it('preserves known activity names and drops dynamic workflow identifiers', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('@temporalio/interceptor');
  tracer.startSpan('RunActivity:diagnose').end();
  tracer.startSpan('DescribeWorkflow:customer-secret').end();
  await provider.forceFlush();
  const [activity, workflow] = exporter.getFinishedSpans().map(sanitizeSpan);
  expect(activity?.name).toBe('temporal.RunActivity.diagnose');
  expect(workflow?.name).toBe('temporal.DescribeWorkflow');
  await provider.shutdown();
});

it('keeps pools distinct without exposing their connection destinations', async () => {
  const { metricAttributes } = await import('./local-span-processor.js');
  const first = metricAttributes({
    'db.client.connection.pool.name': 'private-user@database-one',
    'db.client.connection.state': 'used',
    'url.full': 'secret',
  });
  const second = metricAttributes({
    'db.client.connection.pool.name': 'private-user@database-two',
    'db.client.connection.state': 'used',
  });
  expect(first.pool).not.toBe(second.pool);
  expect(first['db.client.connection.state']).toBe('used');
  expect(JSON.stringify(first)).not.toMatch(/private|database|secret/);
});

it('keeps concurrent request spans separate while automatic children inherit their parent', async () => {
  const { context, propagation, trace } = await import('@opentelemetry/api');
  const { createObservability } = await import('./observability.js');
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  const telemetry = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 1,
    local: { endpoint: 'http://127.0.0.1:4318' },
  });
  try {
    const requests = [telemetry.request('first'), telemetry.request('second')];
    await Promise.all(
      requests.map((request) =>
        telemetry.withContext!(request.context, async () => {
          await Promise.resolve();
          trace.getTracer('automatic').startSpan('db.query').end();
          await telemetry.run(request.context, 'model.generate', async () => {
            await Promise.resolve();
            trace.getTracer('automatic').startSpan('HTTP POST').end();
          });
          request.end();
        }),
      ),
    );
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(
      new Set(requests.map((request) => request.context.traceId)).size,
    ).toBe(2);
    for (const request of requests) {
      const children = spans.filter(
        (span) => span.spanContext().traceId === request.context.traceId,
      );
      expect(children).toHaveLength(4);
      expect(
        children.find((span) => span.name === 'db.query')?.parentSpanContext
          ?.spanId,
      ).toBe(request.context.spanId);
      const model = children.find((span) => span.name === 'model.generate')!;
      expect(
        children.find((span) => span.name === 'HTTP POST')?.parentSpanContext
          ?.spanId,
      ).toBe(model.spanContext().spanId);
    }
  } finally {
    await telemetry.shutdown();
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  }
});

it('records local request failures on the request span and in the log stream', async () => {
  const { context, propagation, trace } = await import('@opentelemetry/api');
  const { logs } = await import('@opentelemetry/api-logs');
  const {
    InMemoryLogRecordExporter,
    LoggerProvider,
    SimpleLogRecordProcessor,
  } = await import('@opentelemetry/sdk-logs');
  const { createObservability } = await import('./observability.js');
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [
      localSpanProcessor(new SimpleSpanProcessor(exporter), () => ({
        record: vi.fn(),
      })),
    ],
  });
  provider.register();
  const records = new InMemoryLogRecordExporter();
  const logger = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: records })],
  });
  logs.setGlobalLoggerProvider(logger);
  const telemetry = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 1,
    local: { endpoint: 'http://127.0.0.1:4318' },
  });
  try {
    const route = '/v1/organizations/:organizationId/operations/overview';
    const request = telemetry.request('request', undefined, {
      route,
      method: 'GET',
    });
    telemetry.captureError(
      new Error('Overview failed', { cause: new Error('statement timeout') }),
      {
        context: request.context,
        request: {
          method: 'GET',
          route,
          url: '/v1/organizations/private/operations/overview?window=24h&q=secret',
          headers: { cookie: 'secret' },
        },
      },
    );
    request.end('error');
    await provider.forceFlush();
    const [span] = exporter.getFinishedSpans();
    const url =
      '/v1/organizations/:organizationId/operations/overview?window=24h&q=[Filtered]';
    expect(span?.attributes['luma.http.url']).toBe(url);
    expect(span?.events[0]?.attributes).toMatchObject({
      'exception.message': 'Overview failed',
      'exception.stacktrace': expect.stringContaining(
        'Caused by: Error: statement timeout',
      ),
    });
    const failure = records
      .getFinishedLogRecords()
      .find((record) => record.body === 'Request failed');
    expect(failure?.attributes).toMatchObject({
      'exception.message': 'Overview failed',
      'http.route': route,
      'luma.http.url': url,
      request_id: 'request',
    });
    expect(failure?.spanContext?.traceId).toBe(request.context.traceId);
    expect(JSON.stringify(failure?.attributes)).not.toMatch(/secret|private/);
  } finally {
    await telemetry.shutdown();
    await provider.shutdown();
    await logger.shutdown();
    logs.disable();
    trace.disable();
    context.disable();
    propagation.disable();
  }
});
