/** A provider record identity, as connections report it. */
export interface SourceRef {
  externalId: string;
  scopeKey: string;
}

/**
 * Where a request to create a case's return in a connected system stands.
 * - `approval_required`, `approved`: waiting for a second person, then for dispatch.
 * - `sending`: Luma is dispatching it once through Action Admission.
 * - `uncertain`: the system did not confirm; Luma only checks by reading, never sends again.
 * - `created`: an independent read found exactly the approved return.
 * - `rejected`, `expired`, `failed`, `not_executed`: nothing more happens; a new request is needed.
 */
export type CreationState =
  | 'approval_required'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'sending'
  | 'uncertain'
  | 'created'
  | 'failed'
  | 'not_executed';

/** Why a request ended without a created return. */
export type CreationFailure =
  /** Policy or the approval no longer allows the action. Nothing was sent. */
  | 'withheld'
  /** The system refused the request before accepting it. Nothing was created. */
  | 'not_accepted'
  /** The system holds a return for this case that does not match the approved lines. */
  | 'mismatch'
  /** The case, its lines or the approval changed. Nothing was sent. */
  | 'changed'
  /** Dispatch failed before the request reached the system. */
  | 'not_sent';

/**
 * One request to create a return case's return in the system its order came from. Lines, the
 * warehouse and the reason are fixed when it is requested; approval binds exactly these.
 */
export interface ReturnCreation {
  id: string;
  tenantId: string;
  caseId: string;
  connectionId: string;
  order: SourceRef;
  /** Present when this request approves a source return that already exists. */
  requestedReturn?: SourceRef;
  warehouse: SourceRef & { name: string | null };
  reason: SourceRef & { name: string | null };
  lines: { orderLineId: string; source: SourceRef; quantity: number }[];
  actionId: string;
  decisionId: string | null;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  state: CreationState;
  /** The system's return, once an independent read found it. */
  externalReturn: { externalId: string; number: string | null } | null;
  createdAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  failure: CreationFailure | null;
  updatedAt: string;
}

/** States that still hold the case's single creation slot. */
export const liveCreationStates: readonly CreationState[] = [
  'approval_required',
  'approved',
  'sending',
  'uncertain',
  'created',
];

/** A creation found in the system for a case, from a fresh read. */
export interface FoundReturn {
  observationId: string;
  observedAt: string;
  externalId: string;
  number: string | null;
  lines: { orderLine: SourceRef | null; quantity: string }[];
}

/**
 * Whether a found return holds exactly the approved lines and units. Lines without an order
 * line, extra lines and changed quantities do not match.
 */
export function matchesCreation(
  creation: Pick<ReturnCreation, 'lines'>,
  found: FoundReturn,
) {
  const quantities = new Map<string, number>();
  for (const line of found.lines) {
    const quantity = Number(line.quantity);
    if (!line.orderLine || !Number.isSafeInteger(quantity) || quantity <= 0)
      return false;
    const key = JSON.stringify([
      line.orderLine.externalId,
      line.orderLine.scopeKey,
    ]);
    quantities.set(key, (quantities.get(key) ?? 0) + quantity);
  }

  return (
    quantities.size === creation.lines.length &&
    creation.lines.every(
      (line) =>
        quantities.get(
          JSON.stringify([line.source.externalId, line.source.scopeKey]),
        ) === line.quantity,
    )
  );
}
