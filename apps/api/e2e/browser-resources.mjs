/** Provides isolated contexts and reverse-order cleanup, attempting every cleanup even after failures. */
export async function useBrowserResources({ browser }, use, testInfo) {
  const cleanup = [];
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

      return context;
    },
    async newPage(options) {
      return (await resources.newContext(options)).newPage();
    },
  };
  let bodyError;
  try {
    await use(resources);
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
