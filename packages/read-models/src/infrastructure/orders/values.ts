import type { Money, OrderSource } from '../../application/orders.js';

/** Normalizes a database or JSON timestamp to ISO 8601, or null when absent or invalid. */
export function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);

  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** Returns the value when it is a string, otherwise null. */
export function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Returns the value when it is a plain JSON object, otherwise an empty object. */
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads a canonical total, or null when the source did not report one. */
export function money(value: unknown): Money | null {
  const total = object(value);

  return typeof total.amount === 'string' && typeof total.currency === 'string'
    ? { amount: total.amount, currency: total.currency }
    : null;
}

/** Reads the display label of a source connection from its installation document. */
export function connectionLabel(connection: Record<string, unknown>) {
  return (
    text(connection.label) ??
    text(object(connection.target).kind) ??
    'Connected source'
  );
}

/** Maps a JSON source summary built by the list query. */
export function source(value: Record<string, unknown>): OrderSource {
  return {
    connectionId: String(value.connectionId),
    label: text(value.label) ?? 'Connected source',
    system: text(value.system),
    connectionStatus: text(value.connectionStatus) ?? 'unknown',
    externalId: text(value.externalId),
    selected: value.selected === true,
    deleted: value.deleted === true,
    observedAt: iso(value.observedAt)!,
    sourceUpdatedAt: iso(value.sourceUpdatedAt),
  };
}
