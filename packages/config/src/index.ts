const levels = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;
type LogLevel = (typeof levels)[number];

export interface ApiConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
}

/** Read once at startup; never expose the server environment to browser code. */
export function readApiConfig(
  env: Readonly<Record<string, string | undefined>>,
): ApiConfig {
  const port = env.PORT ?? '3001';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim()) throw new Error('HOST must not be empty');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!levels.includes(logLevel as LogLevel))
    throw new Error('LOG_LEVEL is invalid');
  return { host, port: Number(port), logLevel: logLevel as LogLevel };
}
