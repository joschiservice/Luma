import { createHmac } from 'node:crypto';

import { LangfuseSpanProcessor } from '@langfuse/otel';
import type { Attributes, Span } from '@opentelemetry/api';
import {
  context as otelContext,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
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
import type { PostHogOptions } from 'posthog-node';
import { PostHog } from 'posthog-node';

import type { ErrorDetails } from '../application/error-details.js';
import { describeError } from '../application/error-details.js';
import type { DataRegion } from '../application/model-gateway.js';
import type {
  ActivityFailureContext,
  FeatureFlag,
  Observability,
  Observation,
  Operation,
  TraceContext,
} from '../application/observability.js';
import { featureFlags } from '../application/observability.js';
import { redactHttpFailure } from './redaction.js';

// This adapter accepts only deployment settings; it does not read ambient environment.
export interface TelemetrySettings {
  dataRegion?: DataRegion;
  environment: 'development' | 'test' | 'staging' | 'production';
  release: string;
  sampleRate: number;
  approvedModels?: readonly string[];
  tenantHashKey?: string;
  local?: { endpoint: string; profilesEndpoint?: string };
  sentryDsn?: string;
  langfuse?: { publicKey: string; secretKey: string; baseUrl: string };
  posthog?: { apiKey: string; host: string; secretKey?: string };
  featureFlagOverrides?: Readonly<Record<string, boolean>>;
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

/**
 * Explicit context keeps concurrent requests and background work isolated. PostHog receives
 * product events and evaluates flags only in staging and production. Throws when a flag
 * override names a flag outside the allowlist.
 */
export function createObservability(
  settings: TelemetrySettings,
  testing: {
    spanProcessors?: SpanProcessor[];
    langfuseExporter?: SpanExporter;
    sentryTransport?: NonNullable<
      Parameters<typeof Sentry.init>[0]
    >['transport'];
    posthog?: Pick<PostHog, 'capture' | 'isFeatureEnabled' | 'shutdown'>;
    posthogFetch?: PostHogOptions['fetch'];
  } = {},
): Observability {
  // Development and test never contact PostHog: no product events, and flags use overrides
  // or the fallback.
  const usePostHog =
    settings.environment === 'staging' || settings.environment === 'production';
  const flagOverrides = new Map<string, boolean>();
  for (const [flag, enabled] of Object.entries(
    settings.featureFlagOverrides ?? {},
  )) {
    if (!isFeatureFlag(flag))
      throw new Error(`Feature flag override ${flag} is not an allowed flag`);
    flagOverrides.set(flag, enabled);
  }
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
        integrations: [
          Sentry.linkedErrorsIntegration(),
          Sentry.onUncaughtExceptionIntegration(),
          // Strict mode keeps Node's default exit after the event is flushed.
          Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
        ],
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
        beforeSend(event, hint) {
          // Rebuild events from explicit data so ambient scope, extras and breadcrumbs never leave.
          const data = hint.data as Partial<FailureData> | undefined;
          const activity = data?.activityFailure;
          const context = data?.context;
          const http = data?.http;
          const message = data?.message;

          return {
            type: undefined,
            ...(event.event_id ? { event_id: event.event_id } : {}),
            ...(event.timestamp ? { timestamp: event.timestamp } : {}),
            platform: 'node',
            environment: settings.environment,
            release: settings.release,
            level: event.level === 'fatal' ? 'fatal' : 'error',
            ...(event.exception
              ? { exception: event.exception }
              : { message: 'Operation failed' }),
            ...(http
              ? {
                  transaction: `${http.method} ${http.route}`,
                  request: {
                    method: http.method,
                    url: http.url,
                    headers: http.headers,
                  },
                }
              : message
                ? { transaction: message }
                : {}),
            tags: {
              ...safeTags(context ? metadata(context) : event.tags),
              ...(http
                ? { 'http.method': http.method, 'http.route': http.route }
                : {}),
            },
            contexts: {
              ...(context
                ? {
                    trace: {
                      trace_id: context.traceId,
                      span_id: context.spanId,
                    },
                  }
                : event.contexts?.trace
                  ? { trace: event.contexts.trace }
                  : {}),
              ...(activity
                ? {
                    temporal: {
                      workflowId: activity.workflowId,
                      workflowRunId: activity.workflowRunId,
                      activityId: activity.activityId,
                      activityType: activity.activityType,
                      attempt: activity.attempt,
                      taskQueue: activity.taskQueue,
                      namespace: activity.namespace,
                    },
                  }
                : {}),
            },
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
  const tracer = settings.local
    ? trace.getTracer('luma')
    : provider.getTracer('luma');
  const activeSpans = new Map<string, Span>();
  const posthog = usePostHog
    ? (testing.posthog ??
      (settings.posthog
        ? new PostHog(settings.posthog.apiKey, {
            host: settings.posthog.host,
            ...(testing.posthogFetch ? { fetch: testing.posthogFetch } : {}),
            disableGeoip: true,
            requestTimeout: 3000,
            fetchRetryCount: 0,
            enableExceptionAutocapture: false,
            sendFeatureFlagEvent: false,
            // Polled definitions keep flag checks off the request path; flags they cannot
            // resolve return the caller's fallback instead of calling PostHog.
            ...(settings.posthog.secretKey
              ? {
                  secretKey: settings.posthog.secretKey,
                  strictLocalEvaluation: true,
                }
              : {}),
          })
        : undefined))
    : undefined;
  if (posthog instanceof PostHog)
    posthog.on('error', () => {
      // Vendor failures must not serialize request data or interrupt business operations.
    });

  function metadata(context: TraceContext): Attributes {
    return {
      environment: settings.environment,
      release: settings.release,
      data_region: settings.dataRegion ?? 'AU',
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
        : settings.local
          ? otelContext.active()
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
          if (settings.local)
            logs.getLogger('luma').emit({
              body: 'Operation completed',
              severityNumber:
                status === 'error' ? SeverityNumber.ERROR : SeverityNumber.INFO,
              attributes: { operation, status, request_id: context.requestId },
              context: trace.setSpan(ROOT_CONTEXT, span),
            });
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
    request(requestId, actionId, http) {
      const observation = start(undefined, 'api.request', requestId, actionId);
      if (http)
        activeSpans.get(observation.context.spanId)?.setAttributes({
          'http.route': http.route,
          'http.request.method': http.method,
        });

      return observation;
    },
    withContext(context, work) {
      const span = activeSpans.get(context.spanId);

      return otelContext.with(
        span ? trace.setSpan(otelContext.active(), span) : otelContext.active(),
        work,
      );
    },
    dataRegion: settings.dataRegion ?? 'AU',
    forTenant(context, tenantId, dataRegion) {
      if (dataRegion !== (settings.dataRegion ?? 'AU'))
        throw new Error('Tenant telemetry requires matching cell placement');
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
        const span = activeSpans.get(observation.context.spanId)!;
        const result = await otelContext.with(
          trace.setSpan(otelContext.active(), span),
          () => work(observation.context, observation),
        );
        observation.end();

        return result;
      } catch (error) {
        observation.end('error');
        throw error;
      }
    },
    captureError(error, { context, request, message } = {}) {
      const http = request ? redactHttpFailure(request) : undefined;
      if (settings.local) {
        const exception = exceptionAttributes(describeError(error));
        const span = context ? activeSpans.get(context.spanId) : undefined;
        span?.addEvent('exception', exception);
        if (http) span?.setAttribute('luma.http.url', http.url);
        logs.getLogger('luma').emit({
          body: message ?? (http ? 'Request failed' : 'Operation failed'),
          severityNumber: SeverityNumber.ERROR,
          severityText: 'ERROR',
          attributes: {
            ...exception,
            ...(context ? { request_id: context.requestId } : {}),
            ...(http
              ? {
                  'http.request.method': http.method,
                  'http.route': http.route,
                  'luma.http.url': http.url,
                }
              : {}),
          },
          context: span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT,
        });
      }
      const data: FailureData = {
        ...(context ? { context } : {}),
        ...(http ? { http } : {}),
        ...(message ? { message } : {}),
      };
      sentry?.captureException(error, { originalException: error, data });
    },
    captureActivityError(error, context) {
      if (settings.local)
        logs.getLogger('luma').emit({
          body: 'Workflow activity failed',
          severityNumber: SeverityNumber.ERROR,
          severityText: 'ERROR',
          attributes: {
            ...exceptionAttributes(describeError(error)),
            'temporal.workflow_id': context.workflowId,
            'temporal.run_id': context.workflowRunId,
            'temporal.activity_id': context.activityId,
            'temporal.activity_type': context.activityType,
            'temporal.attempt': context.attempt,
            'temporal.task_queue': context.taskQueue,
          },
        });
      const data: FailureData = { activityFailure: context };
      sentry?.captureException(error, { originalException: error, data });
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
      if (!isFeatureFlag(flag)) return fallback;
      const override = flagOverrides.get(flag);
      if (override !== undefined) return override;
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

function isFeatureFlag(value: string): value is FeatureFlag {
  return (featureFlags as readonly string[]).includes(value);
}

interface FailureData {
  context?: TraceContext;
  message?: string;
  http?: ReturnType<typeof redactHttpFailure>;
  activityFailure?: ActivityFailureContext;
}

/** OpenTelemetry exception attributes, with linked causes appended to the stack trace. */
function exceptionAttributes(details: ErrorDetails): Attributes {
  return {
    'exception.type': details.type,
    'exception.message': details.message,
    'exception.stacktrace': stackTrace(details),
    ...(details.code ? { 'error.type': details.code } : {}),
  };
}

function stackTrace(details: ErrorDetails): string {
  const own = details.stack ?? `${details.type}: ${details.message}`;

  return details.cause
    ? `${own}\nCaused by: ${stackTrace(details.cause)}`
    : own;
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
