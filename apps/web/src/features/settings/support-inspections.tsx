import type { SupportInspection } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';

const emergencyLabel = (
  category: NonNullable<SupportInspection['emergency']>,
) =>
  category === 'security_incident'
    ? m.settings_support_inspection_emergency_security_incident()
    : m.settings_support_inspection_emergency_legal_request();

/**
 * Lists Luma support inspection requests and open inspections. Pending requests show the
 * support team's reason with Approve and Decline; approved consented access can be ended early.
 * Emergency access shows its category and end, and can't be ended here.
 */
export function SupportInspectionList({
  items,
  locked,
  onDecide,
  onRevoke,
}: {
  items: SupportInspection[];
  locked: boolean;
  onDecide: (id: string, decision: 'approve' | 'decline') => void;
  onRevoke: (id: string) => void;
}) {
  return (
    <>
      {items.map((item) => {
        const summaryId = `support-inspection-${item.id}`;

        return (
          <div key={item.id} className="settings-support-request">
            <div id={summaryId}>
              {item.emergency ? (
                <>
                  <Badge tone="warning">{emergencyLabel(item.emergency)}</Badge>
                  <p>
                    {m.settings_support_inspection_emergency_note()}{' '}
                    {item.accessExpiresAt ? (
                      <WorkspaceDate value={item.accessExpiresAt} />
                    ) : null}
                  </p>
                </>
              ) : item.status === 'pending' ? (
                <>
                  <strong>{m.settings_support_inspection_pending()}</strong>
                  {item.reason ? <p>{item.reason}</p> : null}
                  <span>
                    {m.settings_support_request_asked()}{' '}
                    <WorkspaceDate value={item.requestedAt} />
                    {' · '}
                    {m.settings_support_request_lapses()}{' '}
                    <WorkspaceDate value={item.expiresAt} />
                  </span>
                  <span className="settings-support-request-note">
                    {m.settings_support_inspection_reason_note()}
                  </span>
                </>
              ) : (
                <>
                  <strong>
                    {m.settings_support_inspection_open()}{' '}
                    {item.accessExpiresAt ? (
                      <WorkspaceDate value={item.accessExpiresAt} />
                    ) : null}
                  </strong>
                  {item.reason ? <p>{item.reason}</p> : null}
                </>
              )}
            </div>
            {item.emergency ? null : (
              <div className="settings-support-request-actions">
                {item.status === 'pending' ? (
                  <>
                    <Button
                      disabled={locked}
                      aria-describedby={summaryId}
                      onClick={() => onDecide(item.id, 'approve')}
                    >
                      {m.settings_support_request_approve()}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={locked}
                      aria-describedby={summaryId}
                      onClick={() => onDecide(item.id, 'decline')}
                    >
                      {m.settings_support_request_decline()}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    disabled={locked}
                    aria-describedby={summaryId}
                    onClick={() => onRevoke(item.id)}
                  >
                    {m.settings_support_inspection_end()}
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
