import { formatDate } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

/** The closure fields of a workspace in the person's workspace list. */
interface ClosableWorkspace {
  status: 'active' | 'suspended' | 'closed';
  dataDeletionAt: string | null;
  dataDeletedAt: string | null;
}

/**
 * Says what happens to a closed workspace's data: deleted, being deleted, deleted on an
 * announced date, or not yet scheduled. Null for a workspace that isn't closed.
 */
export function closureNotice(
  workspace: ClosableWorkspace,
  now: Date = new Date(),
): string | null {
  if (workspace.status !== 'closed') return null;
  if (workspace.dataDeletedAt)
    return m.identity_workspaces_closed_deleted({
      date: formatDate(workspace.dataDeletedAt),
    });
  if (!workspace.dataDeletionAt) return m.identity_workspaces_closed_pending();
  if (Date.parse(workspace.dataDeletionAt) <= now.getTime())
    return m.identity_workspaces_closed_deleting();

  return m.identity_workspaces_closed_scheduled({
    date: formatDate(workspace.dataDeletionAt),
  });
}
