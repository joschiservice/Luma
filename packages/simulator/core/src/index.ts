export type Phase = 'before' | 'after-commit';

export interface Fault {
  id: string;
  instance: string;
  operation: string;
  resource?: string | undefined;
  phase: Phase;
  kind: 'outage' | 'rate-limit' | 'response-loss';
  occurrence: number;
  remaining: number;
  matches: number;
  expiresAt?: number;
  status: 'armed' | 'triggered' | 'expired' | 'disabled';
}

export interface JournalEntry {
  sequence: number;
  time: number;
  kind: string;
  instance?: string;
  resource?: string | undefined;
  detail: unknown;
}

export interface ScheduledEvent {
  id: number;
  at: number;
  command: unknown;
}

export interface Clock {
  now: number;
  running: boolean;
  speed: number;
  sequence: number;
  events: ScheduledEvent[];
  journal: JournalEntry[];
  faults: Fault[];
}

/** Creates a deterministic clock; transport deadlines always use real time. */
export function createClock(): Clock {
  return {
    now: Date.parse('2026-01-01T00:00:00Z'),
    running: false,
    speed: 1,
    sequence: 0,
    events: [],
    journal: [],
    faults: [],
  };
}

/** Appends an ordered event without recording credentials. */
export function journal(
  clock: Clock,
  kind: string,
  detail: unknown,
  instance?: string,
  resource?: string,
) {
  clock.journal.push({
    sequence: ++clock.sequence,
    time: clock.now,
    kind,
    detail,
    ...(instance ? { instance } : {}),
    ...(resource ? { resource } : {}),
  });
}

/** Schedules a command with a stable tie-breaker for equal timestamps. */
export function schedule(clock: Clock, delay: number, command: unknown) {
  if (!Number.isFinite(delay) || delay < 0) throw new Error('Invalid delay');
  const event = { id: ++clock.sequence, at: clock.now + delay, command };
  clock.events.push(event);
  clock.events.sort((a, b) => a.at - b.at || a.id - b.id);

  return event;
}

/** Advances commerce time and removes each event before applying its transition. Persist the enclosing transaction. */
export function advance(
  clock: Clock,
  milliseconds: number,
  apply: (command: unknown) => void,
) {
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 86400000
  )
    throw new Error('Advance must be between zero and one day');
  const end = clock.now + milliseconds;
  let count = 0;
  while (clock.events[0] && clock.events[0].at <= end) {
    if (++count > 10000) throw new Error('Scheduled event limit exceeded');
    const event = clock.events.shift()!;
    clock.now = event.at;
    journal(clock, 'scheduled', event);
    apply(event.command);
  }
  clock.now = end;
  for (const fault of clock.faults)
    if (
      fault.status === 'armed' &&
      fault.expiresAt !== undefined &&
      fault.expiresAt <= end
    )
      fault.status = 'expired';
}

/** Consumes matching fault counts in request order. The caller persists before delivering a response. */
export function matchFault(
  clock: Clock,
  target: {
    instance: string;
    operation: string;
    resource?: string | undefined;
    phase: Phase;
  },
) {
  for (const fault of clock.faults) {
    if (fault.status !== 'armed') continue;
    if (fault.expiresAt !== undefined && fault.expiresAt <= clock.now) {
      fault.status = 'expired';
      continue;
    }
    if (
      fault.instance !== target.instance ||
      (fault.operation !== '*' && fault.operation !== target.operation) ||
      fault.phase !== target.phase ||
      (fault.resource !== undefined && fault.resource !== target.resource)
    )
      continue;
    if (++fault.matches < fault.occurrence) continue;
    if (--fault.remaining === 0) fault.status = 'triggered';
    journal(
      clock,
      'fault',
      {
        id: fault.id,
        kind: fault.kind,
        operation: target.operation,
        phase: target.phase,
      },
      target.instance,
      target.resource,
    );

    return fault;
  }

  return undefined;
}

export interface ProviderRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  lost?: boolean;
  /** True only when the provider handler committed a mutation. */
  committed?: boolean;
}

/** Constructs a provider JSON response. */
export function json(body: unknown, status = 200): ProviderResponse {
  return { body, status, headers: { 'content-type': 'application/json' } };
}

/** Converts provider handlers to fetch while honoring cancellation before and after dispatch. */
export function createTransport(
  dispatch: (request: ProviderRequest) => Promise<ProviderResponse>,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const responsePromise = dispatch({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.body ? await request.text() : null,
    });
    let abort: (() => void) | undefined;
    try {
      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) => {
          abort = () => reject(request.signal.reason);
          request.signal.addEventListener('abort', abort, { once: true });
          if (request.signal.aborted) abort();
        }),
      ]);
      request.signal.throwIfAborted();
      if (response.lost)
        throw new TypeError('Simulated response lost after commit');

      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      if (abort) request.signal.removeEventListener('abort', abort);
    }
  };
}
