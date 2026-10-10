export const auditPageSize = 50;

/** Optional staff audit filters; staff member and account accept an ID or an exact email address. */
export interface AuditQuery {
  staff?: string | undefined;
  workspace?: string | undefined;
  account?: string | undefined;
  event?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
}

/** One page of staff audit entries, newest first. Names are null once their record is gone. */
export interface AuditPage {
  entries: {
    sequence: string;
    createdAt: string;
    event: string;
    outcome: 'succeeded' | 'failed';
    requestId: string;
    reason: string | null;
    details: Record<string, unknown>;
    staff: { id: string; name: string | null; email: string | null } | null;
    workspace: { id: string; name: string | null } | null;
    account: { id: string; name: string | null; email: string | null } | null;
  }[];
  nextCursor: string | null;
}
