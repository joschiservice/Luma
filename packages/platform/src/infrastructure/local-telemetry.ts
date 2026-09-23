import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-node';

import { installPerformance } from '../application/performance.js';
import {
  localSpanProcessor,
  metricAttributes,
  queryMetadata,
} from './local-span-processor.js';
import type { TelemetrySettings } from './observability.js';

/** Starts loopback-only telemetry before application modules load; the caller must close it. */
export async function startLocalTelemetry(
  settings: TelemetrySettings,
  serviceName: string,
) {
  if (!settings.local) return undefined;
  const { endpoint, profilesEndpoint } = settings.local;
  const resource = resourceFromAttributes({
    'service.name': serviceName,
    'service.version': settings.release,
    'deployment.environment.name': settings.environment,
  });
  const spanProcessor = localSpanProcessor(
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: `${endpoint}/v1/traces`,
        timeoutMillis: 3000,
      }),
      { scheduledDelayMillis: 1000, exportTimeoutMillis: 3000 },
    ),
    () => duration,
  );
  const sdk = new NodeSDK({
    resource,
    autoDetectResources: false,
    sampler: new AlwaysOnSampler(),
    spanProcessors: [spanProcessor],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: `${endpoint}/v1/logs`,
          timeoutMillis: 3000,
        }),
      }),
    ],
    views: [
      {
        instrumentName: '*',
        attributesProcessors: [{ process: metricAttributes }],
      },
    ],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${endpoint}/v1/metrics`,
          timeoutMillis: 3000,
        }),
        exportIntervalMillis: 5000,
        exportTimeoutMillis: 3000,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation({
        ignoreRequestHook: (request) =>
          request.origin === endpoint || request.origin === profilesEndpoint,
      }),
      new PgInstrumentation({
        enhancedDatabaseReporting: false,
        requestHook(span, info) {
          span.setAttributes(queryMetadata(info.query.text));
        },
        responseHook(span, info) {
          if (info.data.rowCount !== null)
            span.setAttribute('db.response.returned_rows', info.data.rowCount);
        },
      }),
      new RuntimeNodeInstrumentation(),
    ],
  });
  sdk.start();
  const duration = metrics
    .getMeter('luma')
    .createHistogram('luma.operation.duration', {
      unit: 's',
      description: 'Elapsed time of completed operations',
      advice: {
        explicitBucketBoundaries: [
          0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
          60,
        ],
      },
    });

  const meter = metrics.getMeter('luma.runtime');
  meter
    .createObservableGauge('luma.process.memory.rss', { unit: 'By' })
    .addCallback((result) => result.observe(process.memoryUsage().rss));
  meter
    .createObservableCounter('luma.process.cpu.time', { unit: 's' })
    .addCallback((result) => {
      const cpu = process.cpuUsage();
      result.observe((cpu.user + cpu.system) / 1e6);
    });

  const tracer = trace.getTracer('luma.performance');
  const performanceAdapter = {
    sync<T>(operation: string, work: () => T): T {
      return tracer.startActiveSpan(operation, (span) => {
        try {
          return work();
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    },
    async<T>(operation: string, work: () => Promise<T>): Promise<T> {
      return tracer.startActiveSpan(operation, async (span) => {
        try {
          return await work();
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    },
  };
  const restorePerformance = installPerformance(performanceAdapter);
  let stopProfiles: (() => Promise<void>) | undefined;
  try {
    if (profilesEndpoint) {
      const { default: pyroscope } = await import('@pyroscope/nodejs');
      pyroscope.init({
        appName: serviceName,
        serverAddress: profilesEndpoint,
        flushIntervalMs: 10000,
        wall: { collectCpuTime: true, samplingDurationMs: 10000 },
        tags: { environment: settings.environment, release: settings.release },
      });
      pyroscope.start();
      stopProfiles = () => pyroscope.stop();
    }
  } catch (error) {
    restorePerformance();
    await sdk.shutdown();
    throw error;
  }
  let closed = false;

  return {
    resource,
    spanProcessor,
    measureSync: performanceAdapter.sync,
    async shutdown() {
      if (closed) return;
      closed = true;
      restorePerformance();
      try {
        await stopProfiles?.();
      } finally {
        await sdk.shutdown();
      }
    },
  };
}
