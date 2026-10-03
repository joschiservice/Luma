/**
 * Connects a provisioned simulator run to authenticated Luma routes: inventory checks for the
 * panel and cases for the scorecard. Other runs remain provider-only sandboxes.
 */
export function createOperationsClient({
  apiOrigin,
  webOrigin,
  password,
  organizationId,
  runId,
}) {
  let cookie;

  async function login() {
    const response = await fetch(`${apiOrigin}/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: webOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pilot-operator@example.test', password }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error('Could not sign in to the simulator workspace');
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  }

  async function request(path, method = 'GET') {
    if (!cookie) await login();
    const send = () =>
      fetch(
        `${apiOrigin}/v1/organizations/${organizationId}/simulator/${path}`,
        {
          method,
          headers: { origin: webOrigin, cookie },
          signal: AbortSignal.timeout(30000),
        },
      );
    let response = await send();
    if (response.status === 401) {
      await login();
      response = await send();
    }
    if (!response.ok) throw new Error('Luma is unavailable');

    return response.json();
  }

  return {
    /** Reads or runs the inventory check for the bound run. */
    async operations(id, action) {
      if (id !== runId) return { connected: false };
      const result = await request(
        action === 'check' ? 'inventory/check' : 'inventory',
        action === 'check' ? 'POST' : 'GET',
      );

      return {
        ...result,
        caseUrl: result.incident
          ? `${webOrigin}/app/${organizationId}/exceptions/${result.incident.id}`
          : null,
      };
    },
    /** Lists Luma's cases for the scorecard; other runs have none. */
    async cases(id) {
      if (id !== runId) throw new Error('This run is not connected to Luma.');

      return request('cases');
    },
  };
}
