/** Connects a provisioned simulator run to authenticated Luma checks; other runs remain provider-only sandboxes. */
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

  return async (id, action) => {
    if (id !== runId) return { connected: false };
    if (!cookie) await login();
    const path = `/v1/organizations/${organizationId}/simulator/inventory${action === 'check' ? '/check' : ''}`;
    const request = () =>
      fetch(`${apiOrigin}${path}`, {
        method: action === 'check' ? 'POST' : 'GET',
        headers: { origin: webOrigin, cookie },
        signal: AbortSignal.timeout(30000),
      });
    let response = await request();
    if (response.status === 401) {
      await login();
      response = await request();
    }
    if (!response.ok) throw new Error('Luma inventory checks are unavailable');
    const result = await response.json();

    return {
      ...result,
      caseUrl: result.incident
        ? `${webOrigin}/app/${organizationId}/exceptions/${result.incident.id}`
        : null,
    };
  };
}
