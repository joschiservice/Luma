import type { Observability } from './observability.js';

export interface ErrorDetails {
  type: string;
  message: string;
  /** Bounded error code, such as a PostgreSQL SQLSTATE or a Node system error code. */
  code?: string;
  stack?: string;
  cause?: ErrorDetails;
}

const maxCauses = 5;

/**
 * Describes a thrown value by type, message, stack, code and cause chain. Other properties,
 * such as database error details or attached payloads, are omitted.
 */
export function describeError(error: unknown): ErrorDetails {
  return describe(error, 0);
}

function describe(error: unknown, depth: number): ErrorDetails {
  if (!(error instanceof Error))
    return { type: typeof error, message: String(error) };
  const code = (error as { code?: unknown }).code;

  return {
    type: error.name,
    message: error.message,
    ...(typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code)
      ? { code }
      : {}),
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.cause !== undefined && depth < maxCauses
      ? { cause: describe(error.cause, depth + 1) }
      : {}),
  };
}

/**
 * Creates a background failure log that writes the message with error details to stderr and,
 * when observability is supplied, reports the error under that message.
 */
export function createFailureLog(
  observability?: Pick<Observability, 'captureError'>,
) {
  return (message: string, error?: unknown) => {
    if (error === undefined) {
      console.error(message);

      return;
    }
    console.error(message, describeError(error));
    observability?.captureError(error, { message });
  };
}
