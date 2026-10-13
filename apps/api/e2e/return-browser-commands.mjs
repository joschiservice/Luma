import { expect } from './browser-fixtures.mjs';

/** Waits for the actual case command, including its independent provider reads, before asserting the UI result. */
export async function returnBrowserCommand(page, casePath, endpoint, act) {
  const response = page.waitForResponse(
    (value) => {
      const path = new URL(value.url()).pathname;

      return (
        value.request().method() === 'POST' &&
        path.includes(`${casePath}/`) &&
        path.endsWith(`/${endpoint}`)
      );
    },
    { timeout: 45_000 },
  );
  await act();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
}
