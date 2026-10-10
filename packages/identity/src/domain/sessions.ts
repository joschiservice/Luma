/** Session activity is recorded at most this often, so ordinary requests don't write. */
export const sessionActivityIntervalMs = 5 * 60_000;

/**
 * Tells whether a session's last-active time is missing or older than the recording interval.
 * A last-active time in the future counts as current, so clock skew never causes repeated writes.
 */
export function sessionActivityDue(
  lastActiveAt: Date | null | undefined,
  now: Date,
) {
  return (
    !lastActiveAt ||
    now.getTime() - lastActiveAt.getTime() >= sessionActivityIntervalMs
  );
}

export interface DeviceDescription {
  /** Browser family with its major version, such as "Chrome 141", or null when unknown. */
  browser: string | null;
  /** Operating system family, such as "macOS", or null when unknown. */
  os: string | null;
}

const browsers: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/\bOPR\/(\d+)/, 'Opera'],
  [/\bSamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/\bFirefox\/(\d+)/, 'Firefox'],
  [/\bFxiOS\/(\d+)/, 'Firefox'],
  [/\bCriOS\/(\d+)/, 'Chrome'],
  [/\bChrome\/(\d+)/, 'Chrome'],
  [/\bVersion\/(\d+)(?:\.\d+)*(?: Mobile\/\S+)? Safari\//, 'Safari'],
];

const systems: [RegExp, string][] = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/**
 * Approximates the browser and operating system from a user-agent header for display. The
 * header is supplied by the client, so the result is a hint and never security evidence.
 */
export function describeUserAgent(
  userAgent: string | null | undefined,
): DeviceDescription {
  if (!userAgent) return { browser: null, os: null };
  const header = userAgent.slice(0, 512);
  let browser: string | null = null;
  for (const [pattern, name] of browsers) {
    const match = pattern.exec(header);
    if (match) {
      browser = `${name} ${match[1]}`;
      break;
    }
  }
  const os = systems.find(([pattern]) => pattern.test(header))?.[1] ?? null;

  return { browser, os };
}
