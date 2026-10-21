import { Button } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { useInfiniteQuery } from '@tanstack/react-query';

import { Failure, Loading } from './feedback';
import { codeLabel, formatTime, personLabel } from './health';
import { accessHistoryOptions } from './queries';

const eventLabels: Record<string, string> = {
  'member.add': 'Member added',
  'member.update': 'Member role changed',
  'member.remove': 'Member removed',
  'member.suspended': 'Member suspended',
  'member.reactivated': 'Member reactivated',
  'api_app.created': 'API app created',
  'api_app.rotated': 'API app token replaced',
  'api_app.revoked': 'API app revoked',
  'api_app.personal_data_read': 'API app read customer data',
  'invitation.created': 'Invitation sent',
  'invitation.accepted': 'Invitation accepted',
  'invitation.revoked': 'Invitation revoked',
  'role.created': 'Role created',
  'role.updated': 'Role changed',
  'role.archived': 'Role archived',
  'role.app_permissions_removed': 'App permissions removed from role',
  'policy.updated': 'Approval policy changed',
  'workspace.updated': 'Workspace details changed',
  'support_inspection.requested': 'Inspection requested by staff',
  'support_inspection.approved': 'Inspection approved',
  'support_inspection.declined': 'Inspection declined',
  'support_inspection.expired': 'Inspection request lapsed',
  'support_inspection.revoked': 'Inspection revoked',
  'support_inspection.emergency_opened': 'Emergency inspection opened by staff',
};

/** Lists member, invitation, role, policy and workspace changes, newest first, under the support grant. */
export function AccessHistory({
  workspaceId,
  grantId,
}: {
  workspaceId: string;
  grantId: string;
}) {
  const history = useInfiniteQuery(accessHistoryOptions(workspaceId, grantId));
  const events = history.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <section
      className="staff-section"
      aria-labelledby="workspace-access-history"
      aria-busy={history.isFetching}
    >
      <div className="staff-section-header">
        <h2 id="workspace-access-history">Access history</h2>
        {history.data ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void history.refetch()}
          >
            Refresh history
          </Button>
        ) : null}
      </div>
      {history.isPending ? (
        <Loading>Reading access history…</Loading>
      ) : !history.data ? (
        <Failure error={history.error} retry={() => void history.refetch()} />
      ) : (
        <>
          {history.isError ? (
            <Failure
              error={history.error}
              retry={() => void history.refetch()}
            />
          ) : null}
          <DataTable
            caption="Workspace access changes, newest first"
            density="compact"
            rows={events}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'change',
                header: 'Change',
                cell: (row) => (
                  <div>
                    {eventLabels[row.type] ?? codeLabel(row.type)}
                    {row.summary ? (
                      <p className="staff-muted">{row.summary}</p>
                    ) : null}
                  </div>
                ),
              },
              {
                key: 'subject',
                header: 'Member',
                hideOnNarrow: true,
                cell: (row) => (row.subject ? personLabel(row.subject) : '—'),
              },
              {
                key: 'actor',
                header: 'Changed by',
                cell: (row) => personLabel(row.actor),
              },
              {
                key: 'when',
                header: 'When',
                cell: (row) => formatTime(row.createdAt),
              },
            ]}
            empty={
              <Empty>
                <h3>No access changes</h3>
                <p>No member, role, policy or workspace change is recorded.</p>
              </Empty>
            }
          />
          {history.hasNextPage ? (
            <Button
              variant="outline"
              onClick={() => {
                if (!history.isFetchingNextPage) void history.fetchNextPage();
              }}
            >
              {history.isFetchingNextPage
                ? 'Loading older changes…'
                : 'Load older changes'}
            </Button>
          ) : events.length ? (
            <p className="staff-muted">
              This is the oldest recorded access change.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
