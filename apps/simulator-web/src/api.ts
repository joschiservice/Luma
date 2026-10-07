import type {
  Control,
  CreateRun,
  IncidentView,
  InjectIncident,
  JournalPage,
  Metrics,
  OperationsStatus,
  Profiles,
  RecordKindCount,
  RecordPage,
  RunDetail,
  RunScenario,
  RunSummary,
  Scorecard,
  SkuComparison,
  SkuMatch,
} from '@luma/simulator-contract';

/** A public local development value; tests and shared hosts use their own tokens. */
export const defaultToken = 'local-synthetic-simulator-token';

const tokenKey = 'luma-simulator-token';

export interface JournalQuery {
  limit?: number | undefined;
  before?: number | undefined;
  kind?: string | undefined;
  instance?: string | undefined;
}

export interface RecordQuery {
  kind: string;
  after?: string | undefined;
  limit?: number | undefined;
  parent?: string | undefined;
}

/** A failed simulator request. Status 0 means the request never received a response. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Whether an error means the simulator rejected the access token. */
export const isUnauthorized = (error: unknown) =>
  error instanceof ApiError && error.status === 401;

/** Whether an error means no response arrived, so the simulator may be stopped. */
export const isUnreachable = (error: unknown) =>
  error instanceof ApiError && error.status === 0;

/** Returns a readable message for any thrown value. */
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The request failed.';
}

/**
 * Returns the access token for this tab. A `?token=` parameter is stored once and removed
 * from the address so it does not remain in history or shared links.
 */
export function initialToken() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    sessionStorage.setItem(tokenKey, fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', url);
  }

  return sessionStorage.getItem(tokenKey) ?? defaultToken;
}

/** Keeps the access token for this browser tab only. */
export function saveToken(token: string) {
  sessionStorage.setItem(tokenKey, token);
}

const statusMessages: Record<number, string> = {
  401: 'The simulator rejected the access token.',
  404: 'The simulator could not find this resource.',
};

function query(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') params.set(key, String(value));
  const text = params.toString();

  return text ? `?${text}` : '';
}

const segment = encodeURIComponent;

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Creates a client for the simulator control API on the page's origin. Every request carries
 * the bearer token. Failures throw `ApiError` with the host's `{ error }` message, or status 0
 * when the simulator is unreachable.
 */
export function createSimulatorApi(
  token: string,
  fetcher: typeof fetch = fetch,
) {
  async function request<Result>(
    path: string,
    init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
  ): Promise<Result> {
    let response: Response;
    try {
      response = await fetcher(`/api/${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new ApiError('The simulator is unreachable.', 0);
    }
    if (response.status === 204) return undefined as Result;
    const text = await response.text();
    const body = parseJson(text);
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String(body.error)
          : (statusMessages[response.status] ??
            `The simulator answered with HTTP ${response.status}.`);
      throw new ApiError(message, response.status);
    }
    if (body === undefined)
      throw new ApiError(
        'The simulator returned an unreadable response.',
        response.status,
      );

    return body as Result;
  }

  const run = (id: string) => `runs/${segment(id)}`;

  return {
    profiles: () => request<Profiles>('profiles'),
    runs: () => request<RunSummary[]>('runs'),
    run: (id: string) => request<RunDetail>(run(id)),
    createRun: (body: Partial<CreateRun> & { id: string }) =>
      request<RunSummary>('runs', { body }),
    deleteRun: (id: string) => request<void>(run(id), { method: 'DELETE' }),
    control: (id: string, body: Control) =>
      request<RunDetail>(`${run(id)}/control`, { body }),
    journal: (id: string, filters: JournalQuery) =>
      request<JournalPage>(`${run(id)}/journal${query({ ...filters })}`),
    metrics: (id: string, windowMs: number) =>
      request<Metrics>(`${run(id)}/metrics${query({ windowMs })}`),
    incidents: (id: string) => request<IncidentView[]>(`${run(id)}/incidents`),
    injectIncident: (id: string, body: InjectIncident) =>
      request<IncidentView>(`${run(id)}/incidents`, { body }),
    runScenario: (id: string, body: RunScenario) =>
      request<IncidentView[]>(`${run(id)}/scenarios`, { body }),
    recoverIncident: (id: string, incident: string) =>
      request<IncidentView>(
        `${run(id)}/incidents/${segment(incident)}/recover`,
        { body: {} },
      ),
    scorecard: (id: string) => request<Scorecard>(`${run(id)}/scorecard`),
    recordKinds: (id: string, instance: string) =>
      request<RecordKindCount[]>(
        `${run(id)}/records/${segment(instance)}/kinds`,
      ),
    records: (id: string, instance: string, filters: RecordQuery) =>
      request<RecordPage>(
        `${run(id)}/records/${segment(instance)}${query({ ...filters })}`,
      ),
    skus: (id: string, prefix: string) =>
      request<SkuMatch[]>(`${run(id)}/skus${query({ q: prefix })}`),
    sku: (id: string, sku: string) =>
      request<SkuComparison>(`${run(id)}/skus/${segment(sku)}`),
    operations: (id: string) =>
      request<OperationsStatus>(`${run(id)}/operations`),
    checkOperations: (id: string) =>
      request<OperationsStatus>(`${run(id)}/operations/check`, { body: {} }),
  };
}

export type SimulatorApi = ReturnType<typeof createSimulatorApi>;
