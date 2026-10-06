import { createHash } from 'node:crypto';

import type { Attributes, Histogram } from '@opentelemetry/api';
import type {
  ReadableSpan,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-node';

const attributes = new Set([
  'http.request.method',
  'http.method',
  'http.route',
  'http.response.status_code',
  'http.status_code',
  'db.system',
  'db.system.name',
  'db.operation.name',
  'luma.db.query_id',
  'db.response.returned_rows',
  'request_id',
  'trace_id',
  'action_id',
  'luma.http.url',
  'model.latency_ms',
  'langfuse.observation.model.name',
  'langfuse.observation.usage_details',
  'langfuse.observation.cost_details',
]);

/** Identifies SQL call sites without exporting statements or bound values. */
export function queryMetadata(sql: string): Attributes {
  const operation =
    /^\s*(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|WITH|SET|SHOW)\b/i
      .exec(sql)?.[1]
      ?.toUpperCase() ?? 'QUERY';

  return {
    'db.system.name': 'postgresql',
    'db.operation.name': operation,
    'luma.db.query_id': createHash('sha256')
      .update(sql)
      .digest('hex')
      .slice(0, 16),
  };
}

const exceptionAttributes = new Set([
  'exception.type',
  'exception.message',
  'exception.stacktrace',
  'error.type',
]);

/**
 * Removes request data, SQL, parameters and workflow identifiers before local export. Error
 * statuses and exception events keep their message and stack so failures are diagnosable.
 */
export function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  const safe = Object.fromEntries(
    Object.entries(span.attributes).filter(([key]) => attributes.has(key)),
  );
  let name = span.name;
  if (span.instrumentationScope.name.includes('instrumentation-pg')) {
    name = safe['db.operation.name']
      ? `db.${safe['db.operation.name']}`
      : span.name.includes('pool')
        ? 'db.pool.acquire'
        : 'db.connect';
  } else if (
    /instrumentation-(http|undici)/.test(span.instrumentationScope.name)
  ) {
    name = `HTTP ${safe['http.request.method'] ?? safe['http.method'] ?? 'request'}`;
  } else if (span.instrumentationScope.name.includes('temporal')) {
    const [prefix, operation] = span.name.split(':');
    const known = [
      'exceptionWorkflow',
      'detect',
      'diagnose',
      'propose',
      'execute',
      'reconcile',
      'verify',
      'refresh',
      'approvalChanged',
      'progress',
    ];
    name = `temporal.${(prefix ?? 'operation').replace(/[^a-zA-Z]/g, '')}${operation && known.includes(operation) ? `.${operation}` : ''}`;
  }

  return {
    ...span,
    name,
    attributes: safe,
    events: span.events
      .filter((event) => event.name === 'exception')
      .map((event) => ({
        name: event.name,
        time: event.time,
        attributes: Object.fromEntries(
          Object.entries(event.attributes ?? {}).filter(([key]) =>
            exceptionAttributes.has(key),
          ),
        ),
      })),
    links: span.links.map((link) => ({ context: link.context })),
    status:
      span.status.code === 2 && span.status.message
        ? { code: span.status.code, message: span.status.message }
        : { code: span.status.code },
    spanContext: () => span.spanContext(),
  };
}

/** Applies redaction and records unsampled local operation-duration histograms. */
export function localSpanProcessor(
  delegate: SpanProcessor,
  duration: () => Histogram,
): SpanProcessor {
  return {
    onStart(span, parent) {
      delegate.onStart(span, parent);
    },
    onEnd(span) {
      const safe = sanitizeSpan(span);
      duration().record(span.duration[0] + span.duration[1] / 1e9, {
        operation: safe.name,
        status: span.status.code === 2 ? 'error' : 'ok',
        ...(safe.attributes['http.route']
          ? { route: safe.attributes['http.route'] }
          : {}),
      });
      delegate.onEnd(safe);
    },
    forceFlush: () => delegate.forceFlush(),
    shutdown: () => delegate.shutdown(),
  };
}

/** Keeps metric dimensions bounded and replaces connection destinations with opaque pool IDs. */
export function metricAttributes(input: Attributes): Attributes {
  const allowed = new Set([
    'operation',
    'status',
    'route',
    'activity',
    'http.route',
    'http.request.method',
    'http.response.status_code',
    'v8js.heap.space.name',
    'v8js.gc.type',
    'nodejs.eventloop.state',
    'nodejs.resource.type',
    'state',
    'db.client.connection.state',
  ]);
  const result: Attributes = Object.fromEntries(
    Object.entries(input).filter(([key]) => allowed.has(key)),
  );
  const pool = input['db.client.connection.pool.name'];
  if (typeof pool === 'string')
    result['pool'] = createHash('sha256')
      .update(pool)
      .digest('hex')
      .slice(0, 12);

  return result;
}
