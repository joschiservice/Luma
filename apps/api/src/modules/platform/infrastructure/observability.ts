import { createHmac } from 'node:crypto';

import { LangfuseSpanProcessor } from '@langfuse/otel';
import type { Attributes, Span } from '@opentelemetry/api';
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import {
  NodeTracerProvider,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import * as Sentry from '@sentry/node';
import {
  SentrySpanProcessor,
  wrapSamplingDecision,
} from '@sentry/opentelemetry';
import { PostHog } from 'posthog-node';

import type {
  Observability,
  Observation,
  Operation,
  TraceContext,
} from '#modules/platform/application/observability';

// This adapter accepts only deployment settings; it does not read ambient environment.
export interface TelemetrySettings {
  environment: 'development' | 'test' | 'staging' | 'production';
  release: string;
  sampleRate: number;
  approvedModels?: readonly string[];
  tenantHashKey?: string;
  sentryDsn?: string;
  langfuse?: { publicKey: string; secretKey: string; baseUrl: string };
  posthog?: { apiKey: string; host: string };
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const operations: Record<Operation, string> = {
  'api.request': 'span',
  'workflow.run': 'chain',
  'agent.run': 'agent',
  'model.generate': 'generation',
  'tool.execute': 'tool',
};

/** Explicit context keeps concurrent requests and background work isolated. */
export function createObservability(
  settings: TelemetrySettings,
  testing: {
    spanProcessors?: SpanProcessor[];
    langfuseExporter?: SpanExporter;
    sentryTransport?: NonNullable<
      Parameters<typeof Sentry.init>[0]
    >['transport'];
    posthog?: Pick<PostHog, 'capture' | 'isFeatureEnabled' | 'shutdown'>;
  } = {},
): Observability {
  const approvedModels = new Set([
    'test-model',
    ...(settings.approvedModels ?? []).filter((model) =>
      /^[a-z0-9][a-z0-9._:/-]{0,159}$/.test(model),
    ),
  ]);
  const sentry = settings.sentryDsn
    ? Sentry.init({
        ...(testing.sentryTransport
          ? { transport: testing.sentryTransport }
          : {}),
        dsn: settings.sentryDsn,
        environment: settings.environment,
        release: settings.release,
        defaultIntegrations: false,
        skipOpenTelemetrySetup: true,
        registerEsmLoaderHooks: false,
        sendDefaultPii: false,
        tracesSampleRate: settings.sampleRate,
        beforeSendTransaction(event) {
          // Only the private tracer produces transactions; drop ambient scope data.
          delete event.user;
          delete event.request;
          delete event.extra;
          delete event.breadcrumbs;
          delete event.server_name;
          event.tags = safeTags(event.tags);
          event.contexts = event.contexts?.trace
            ? { trace: event.contexts.trace }
            : {};

          return event;
        },
        beforeSend(event) {
          return {
            type: undefined,
            ...(event.event_id ? { event_id: event.event_id } : {}),
            ...(event.timestamp ? { timestamp: event.timestamp } : {}),
            platform: 'node',
            environment: settings.environment,
            release: settings.release,
            level: 'error',
            message: 'Operation failed',
            tags: safeTags(event.tags),
            contexts: event.contexts?.trace
              ? { trace: event.contexts.trace }
              : {},
          };
        },
      })
    : undefined;
  const processors = [...(testing.spanProcessors ?? [])];
  if (sentry) processors.push(new SentrySpanProcessor());
  if (settings.langfuse)
    processors.push(
      new LangfuseSpanProcessor({
        ...(testing.langfuseExporter
          ? { exporter: testing.langfuseExporter }
          : {}),
        ...settings.langfuse,
        environment: settings.environment,
        release: settings.release,
        mediaUploadEnabled: false,
        timeout: 3,
        shouldExportSpan: ({ otelSpan }) =>
          otelSpan.instrumentationScope.name === 'luma',
        mask: () => '[REDACTED]',
      }),
    );
  const sampler = new TraceIdRatioBasedSampler(settings.sampleRate);
  const provider = new NodeTracerProvider({
    spanProcessors: processors,
    sampler: {
      shouldSample(context, traceId, _name, _kind, attributes) {
        const result = sampler.shouldSample(context, traceId);

        return sentry
          ? wrapSamplingDecision({
              decision: result.decision,
              context,
              spanAttributes: attributes,
            })
          : result;
      },
      toString: () => 'LumaSampler',
    },
  });
  const tracer = provider.getTracer('luma');
  const activeSpans = new Map<string, Span>();
  const posthog =
    testing.posthog ??
    (settings.posthog
      ? new PostHog(settings.posthog.apiKey, {
          host: settings.posthog.host,
          disableGeoip: true,
          requestTimeout: 3000,
          fetchRetryCount: 0,
          enableExceptionAutocapture: false,
        })
      : undefined);
  if (posthog instanceof PostHog)
    posthog.on('error', () => {
      // Vendor failures must not serialize request data or interrupt business operations.
    });

  function metadata(context: TraceContext): Attributes {
    return {
      environment: settings.environment,
      release: settings.release,
      data_region: 'EU',
      request_id: context.requestId,
      trace_id: context.traceId,
      ...(context.actionId ? { action_id: context.actionId } : {}),
      ...(context.tenantRef ? { tenant_ref: context.tenantRef } : {}),
    };
  }

  function start(
    parent: TraceContext | undefined,
    operation: Operation,
    requestId: string,
    actionId?: string,
  ): Observation {
    if (!Object.hasOwn(operations, operation))
      throw new Error('Unknown telemetry operation');
    const activeParent = parent ? activeSpans.get(parent.spanId) : undefined;
    const parentContext = activeParent
      ? trace.setSpan(ROOT_CONTEXT, activeParent)
      : parent
        ? trace.setSpanContext(ROOT_CONTEXT, {
            traceId: parent.traceId,
            spanId: parent.spanId,
            traceFlags: 1,
            isRemote: true,
          })
        : ROOT_CONTEXT;
    const span = tracer.startSpan(
      operation,
      {
        attributes: {
          'langfuse.observation.type': operations[operation],
          'sentry.op': operation,
        },
      },
      parentContext,
    );
    const context: TraceContext = Object.freeze({
      ...parent,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      requestId,
      ...(actionId && uuid.test(actionId) ? { actionId } : {}),
    });
    activeSpans.set(context.spanId, span);
    span.setAttributes(metadata(context));
    let ended = false;

    return {
      context,
      end(status = 'ok') {
        if (!ended) {
          ended = true;
          activeSpans.delete(context.spanId);
          span.setStatus({
            code: status === 'error' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
          });
          span.end();
        }
      },
      generation(usage) {
        if (operation !== 'model.generate' || !approvedModels.has(usage.model))
          return;
        if (
          ![usage.inputTokens, usage.outputTokens].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
          )
        )
          return;
        span.setAttributes({
          ...(usage.costUsd != null &&
          Number.isFinite(usage.costUsd) &&
          usage.costUsd >= 0
            ? {
                'langfuse.observation.cost_details': JSON.stringify({
                  total: usage.costUsd,
                }),
              }
            : {}),
          ...(usage.latencyMs != null &&
          Number.isFinite(usage.latencyMs) &&
          usage.latencyMs >= 0
            ? { 'model.latency_ms': usage.latencyMs }
            : {}),
          'langfuse.observation.model.name': usage.model,
          'langfuse.observation.usage_details': JSON.stringify({
            input: usage.inputTokens,
            output: usage.outputTokens,
          }),
        });
      },
    };
  }

  const api: Observability = {
    request: (requestId, actionId) =>
      start(undefined, 'api.request', requestId, actionId),
    forTenant(context, tenantId, dataRegion) {
      if (dataRegion !== 'EU')
        throw new Error(
          'Tenant telemetry requires EU placement and a hash key',
        );
      if (!settings.tenantHashKey) {
        if (settings.sentryDsn || settings.langfuse || settings.posthog)
          throw new Error('Tenant telemetry requires a hash key');

        return context;
      }
      const tenantRef = createHmac('sha256', settings.tenantHashKey)
        .update(`${settings.environment}:${tenantId}`)
        .digest('hex');
      const scoped = Object.freeze({ ...context, tenantRef });
      activeSpans.get(context.spanId)?.setAttributes(metadata(scoped));

      return scoped;
    },
    async run(parent, operation, work) {
      const observation = start(parent, operation, parent.requestId);
      try {
        const result = await work(observation.context, observation);
        observation.end();

        return result;
      } catch (error) {
        observation.end('error');
        throw error;
      }
    },
    captureError(context) {
      sentry?.captureEvent({
        message: 'Operation failed',
        level: 'error',
        tags: metadata(context) as Record<string, string>,
        contexts: {
          trace: { trace_id: context.traceId, span_id: context.spanId },
        },
      });
    },
    capture(context, event) {
      if (
        !['connector_provider_viewed', 'observability_test_completed'].includes(
          event,
        )
      )
        return;
      try {
        posthog?.capture({
          distinctId:
            context.tenantRef ?? context.actionId ?? context.requestId,
          event,
          properties: { ...metadata(context), $process_person_profile: false },
          disableGeoip: true,
        });
      } catch {
        /* Analytics is best effort. */
      }
    },
    async flag(context, flag, fallback = false) {
      if (flag !== 'observability-test') return fallback;
      try {
        return (
          (await posthog?.isFeatureEnabled(
            flag,
            context.tenantRef ?? context.actionId ?? context.requestId,
            {
              sendFeatureFlagEvents: false,
              personProperties: { environment: settings.environment },
              disableGeoip: true,
            },
          )) ?? fallback
        );
      } catch {
        return fallback;
      }
    },
    async shutdown() {
      await Promise.allSettled([provider.forceFlush()]);
      await Promise.allSettled([provider.shutdown()]);
      await Promise.allSettled([posthog?.shutdown(), sentry?.close(3000)]);
    },
  };

  return api;
}

function safeTags(
  tags: Record<string, unknown> | undefined,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of ['request_id', 'action_id', 'trace_id', 'tenant_ref']) {
    const value = tags?.[key];
    if (
      typeof value === 'string' &&
      (/^[0-9a-f]{32,64}$/.test(value) || uuid.test(value))
    )
      safe[key] = value;
  }

  return safe;
}
