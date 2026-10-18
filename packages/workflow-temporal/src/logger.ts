import { describeError } from '@luma/platform';
import type { LogEntry } from '@temporalio/worker';
import { DefaultLogger, Runtime } from '@temporalio/worker';

/**
 * Formats a Temporal log entry as one JSON line. Errors anywhere in the metadata are reduced to
 * type, message, code, stack and cause, so database error details and attached payloads are
 * never written.
 */
export function formatLogEntry(entry: LogEntry): string {
  const line = {
    time: new Date(Number(entry.timestampNanos / 1_000_000n)).toISOString(),
    level: entry.level,
    message: entry.message,
  };
  try {
    return JSON.stringify(
      { ...line, ...(entry.meta ? { meta: entry.meta } : {}) },
      (_, value: unknown) =>
        value instanceof Error
          ? describeError(value)
          : typeof value === 'bigint'
            ? value.toString()
            : value,
    );
  } catch {
    // Circular or otherwise unserializable metadata is dropped rather than printed raw.
    return JSON.stringify(line);
  }
}

let installed = false;

/**
 * Installs the process-wide Temporal runtime with a JSON logger writing to stderr. Process entry
 * points call it before the first worker connects; later calls do nothing. Temporal refuses the
 * install once a worker or connection has created the default runtime.
 */
export function installRuntimeLogger() {
  if (installed) return;
  installed = true;
  Runtime.install({
    logger: new DefaultLogger('INFO', (entry) => {
      process.stderr.write(`${formatLogEntry(entry)}\n`);
    }),
  });
}
