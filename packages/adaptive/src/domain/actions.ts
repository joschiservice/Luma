/** Declarative row mappings name validated inputs, never executable presentation logic. */
export interface ViewAction {
  id: string;
  label: { en: string; de: string };
  target: {
    kind: 'capability' | 'workflow';
    id: string;
    version?: string | undefined;
  };
  inputs: Record<
    string,
    | { source: 'row'; field: string }
    | { source: 'literal'; value: string | number | boolean | null }
  >;
}

export type ActionScalar = string | number | boolean | null;

/** A before/after entry in an exported action review.
 * @public Named by composed action service declarations.
 */
export interface ActionChange {
  label: string;
  before: string | null;
  after: string | null;
}

export interface ActionReview {
  changes: ActionChange[];
  scope: string;
  approval: string;
  verification: string;
  /** Immutable owner evidence, included in the review digest and checked again before proposal. */
  evidence: string;
}

export interface ViewActionResult {
  recordId: string;
  state:
    | 'proposed'
    | 'approval_required'
    | 'verified'
    | 'uncertain'
    | 'failed'
    | 'unavailable';
  reason: string | null;
  proposalId: string | null;
  destination: string | null;
}
