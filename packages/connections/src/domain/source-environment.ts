/** Positive classification never follows from the absence of a simulator or a successful read. */
export interface SourceEnvironmentProof {
  environment: 'live' | 'synthetic' | 'unknown';
  provenance: {
    basis:
      | 'reviewed_workspace_declaration'
      | 'simulation_manifest'
      | 'unclassified_source';
    connectionId: string;
    connectionVersion: number;
    credentialVersion: number;
    sourceBinding: string;
    declarationRevision: number | null;
    evidenceId: string | null;
  } | null;
}

/** Immutable review evidence contains source identities and freshness, never provider record payloads. */
export interface SourceEnvironmentReview {
  id: string;
  connectionId: string;
  sourceBinding: string;
  connectionVersion: number;
  credentialVersion: number;
  actorId: string;
  observedAt: string;
  expiresAt: string;
  observations: {
    id: string;
    provider: string;
    resource: string;
    sourceRevision: string | null;
    observedAt: string;
  }[];
}

/** A human declaration describes operational use; it is not provider certification. */
export interface SourceEnvironmentDeclaration {
  connectionId: string;
  revision: number;
  review: SourceEnvironmentReview | null;
  revoked: boolean;
  actorId: string;
  reason: string;
  at: string;
}
