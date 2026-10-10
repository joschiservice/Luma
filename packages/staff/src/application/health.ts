/** Lists hold the most recent entries; counts stop at their cap. */
export const healthListLimit = 20;

export const healthCountCap = 1000;

export const accessHistoryPageSize = 50;

/** A person named through the workspace's people records; `name` is null when none exists. */
export interface StaffPerson {
  id: string;
  name: string | null;
  member: boolean | null;
}

/** A bounded count: exact below the cap, `capped` once it reaches it. */
export interface StaffCount {
  count: number;
  capped: boolean;
}

/** Health metadata, codes and counts for one workspace. Contains no provider or customer payloads. */
export interface WorkspaceHealth {
  readAt: string;
  settings: { timezone: string; alwaysRequireApproval: boolean } | null;
  sync: {
    streams: {
      id: string;
      connectionId: string;
      recordType: string;
      phase: string;
      scan: string | null;
      paused: boolean;
      blocked: string | null;
      attempts: number;
      errorCode: string | null;
      errorMessage: string | null;
      errorAt: string | null;
      failingSince: string | null;
      lastSuccessAt: string | null;
    }[];
    streamsTruncated: boolean;
    runs: {
      id: string;
      connectionId: string;
      recordType: string;
      kind: string;
      trigger: string;
      outcome: string;
      startedAt: string;
      finishedAt: string | null;
      records: number;
      failed: number;
      errors: number;
    }[];
    runsTruncated: boolean;
  };
  connections: {
    items: {
      id: string;
      provider: string;
      status: string;
      version: number;
      credentialVersion: number | null;
    }[];
    itemsTruncated: boolean;
    events: {
      connectionId: string;
      version: number;
      event: string;
      status: string;
      credentialVersion: number;
      actor: StaffPerson;
      createdAt: string;
    }[];
    eventsTruncated: boolean;
    readChecks: {
      connectionId: string;
      capability: string;
      succeeded: boolean;
      errorCode: string | null;
      observedAt: string;
    }[];
    readChecksTruncated: boolean;
  };
  execution: {
    unknown: StaffCount;
    failed: StaffCount;
    actions: {
      id: string;
      proposalId: string;
      state: 'unknown' | 'failed';
      capability: string | null;
      connectionId: string | null;
      dispatch: string | null;
      businessOutcome: string | null;
      updatedAt: string;
    }[];
    actionsTruncated: boolean;
    failures: {
      id: string;
      proposalId: string;
      phase: string | null;
      code: string | null;
      retry: string | null;
      effect: string | null;
      createdAt: string;
    }[];
    failuresTruncated: boolean;
  };
  workflows: {
    steps: {
      runId: string;
      definitionId: string;
      stepId: string;
      kind: string | null;
      state: 'waiting' | 'failed' | 'inconclusive' | 'escalated';
      recordedAt: string | null;
    }[];
    stepsTruncated: boolean;
    awaitingAdmission: StaffCount & { oldestTriggeredAt: string | null };
    activations: {
      id: string;
      definitionId: string;
      principal: StaffPerson;
      createdAt: string;
    }[];
    activationsTruncated: boolean;
  };
  cases: {
    open: number;
    byState: { state: string; count: number }[];
    awaitingApproval: number;
    reviewRequired: number;
  };
  mail: {
    failed: StaffCount;
    items: {
      id: string;
      kind: string;
      attempts: number;
      createdAt: string;
      firstAttemptAt: string | null;
    }[];
    itemsTruncated: boolean;
  };
  apps: {
    appId: string;
    status: string;
    version: number;
    appVersion: string | null;
    updatedAt: string;
  }[];
  appsTruncated: boolean;
}

/** One page of workspace access changes, newest first. */
export interface AccessHistoryPage {
  events: {
    id: string;
    type: string;
    targetId: string;
    actor: StaffPerson;
    subject: StaffPerson | null;
    summary: string | null;
    createdAt: string;
  }[];
  nextCursor: string | null;
}
