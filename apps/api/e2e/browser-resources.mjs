/* global document */

/**
 * Provides isolated contexts and reverse-order cleanup, attempting every cleanup even after
 * failures. A test fails when any of its pages reports a Content Security Policy violation,
 * so framework or feature scripts that miss the response nonce are caught by every journey.
 */
export async function useBrowserResources({ browser }, use, testInfo) {
  const cleanup = [];
  const cspViolations = [];
  let cleanupFailed = false;
  const resources = {
    get failed() {
      return cleanupFailed || testInfo.status !== testInfo.expectedStatus;
    },
    onTestFinished(callback) {
      cleanup.push(callback);
    },
    attach: (name, options) => testInfo.attach(name, options),
    async newContext(options) {
      const context = await browser.newContext(options);
      cleanup.push(() => context.close());
      await context.exposeBinding(
        '__lumaReportCspViolation',
        ({ page }, violation) =>
          cspViolations.push({ page: page.url(), ...violation }),
      );
      await context.addInitScript(() =>
        document.addEventListener('securitypolicyviolation', (event) =>
          globalThis.__lumaReportCspViolation({
            directive: event.effectiveDirective,
            blocked: event.blockedURI,
            source: `${event.sourceFile}:${event.lineNumber}`,
            sample: event.sample,
          }),
        ),
      );

      return context;
    },
    async newPage(options) {
      return (await resources.newContext(options)).newPage();
    },
  };
  let bodyError;
  try {
    await use(resources);
    if (cspViolations.length)
      throw new Error(
        `Content Security Policy violations:\n${cspViolations
          .map((violation) => JSON.stringify(violation))
          .join('\n')}`,
      );
  } catch (error) {
    bodyError = error;
    cleanupFailed = true;
  }
  const errors = [];
  for (const callback of cleanup.reverse()) {
    try {
      await callback();
    } catch (error) {
      cleanupFailed = true;
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      bodyError ? [bodyError, ...errors] : errors,
      'Test resource cleanup failed',
    );
  if (bodyError) throw bodyError;
}
