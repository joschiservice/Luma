import type { StockProtectionPosition } from '@luma/api-contract';
import { formatDateTime, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert, AlertTitle } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useContext, useState } from 'react';

import { IdentityError } from '../../lib/api-error';
import { stockProtectionApi, stockProtectionOptions } from './data';

const status = {
  pending: m.settings_protection_status_pending,
  preview: m.settings_protection_status_preview,
  held: m.settings_protection_status_held,
  tightened: m.settings_protection_status_tightened,
  releasing: m.settings_protection_status_releasing,
  released: m.settings_protection_status_released,
  released_by_sync: m.settings_protection_status_released_by_sync,
  changed_outside_luma: m.settings_protection_status_changed_outside_luma,
  skipped: m.settings_protection_status_skipped,
  not_protected: m.settings_protection_status_not_protected,
  unknown: m.settings_protection_status_unknown,
};
const quantity = (value: number | null) =>
  value === null ? m.common_unknown() : formatNumber(value);
const reasons: Record<string, () => string> = {
  continue_selling: m.settings_protection_reason_continue,
  untracked: m.settings_protection_reason_untracked,
  bundle: m.settings_protection_reason_bundle,
  inactive: m.settings_protection_reason_inactive,
  native_stock: m.settings_protection_reason_native,
  active_correction: m.settings_protection_reason_correction,
  excluded: m.settings_protection_reason_excluded,
  sku_cap: m.settings_protection_reason_cap,
  unit_cap: m.settings_protection_reason_cap,
  incomplete: m.settings_protection_reason_incomplete,
  eligibility_unknown: m.settings_protection_reason_incomplete,
  quantity_unknown: m.settings_protection_reason_incomplete,
  no_reduction: m.settings_protection_reason_no_reduction,
  not_at_risk: m.settings_protection_reason_not_at_risk,
  stopped: m.settings_protection_reason_stopped,
  deferred: m.settings_protection_reason_deferred,
  conflict: m.settings_protection_reason_conflict,
  blocked: m.settings_protection_reason_blocked,
  observe_only: m.settings_protection_reason_observe_only,
  write_uncertain: m.settings_protection_reason_uncertain,
  read_or_admission_unavailable: m.settings_protection_reason_incomplete,
};

/** Shows incident-owned stock changes, retained outcomes and human controls from the same snapshot. */
export function StockProtectionNotice({
  organizationId,
  positionId,
  skuId,
  incidentId,
}: {
  organizationId: string;
  positionId?: string;
  skuId?: string;
  incidentId?: string;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const [offset, setOffset] = useState(0);
  const query = useQuery(
    stockProtectionOptions(organizationId, {
      incidentId,
      positionId,
      skuId,
      offset,
      limit: incidentId || positionId || skuId ? 50 : 0,
    }),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (
    query.error instanceof IdentityError &&
    [401, 403, 404].includes(query.error.status)
  )
    return null;
  if (!query.data || (!query.data.enabled && !query.data.incidents.length))
    return null;
  const incidents = query.data.incidents.filter((i) =>
    incidentId ? i.id === incidentId : i.state !== 'released',
  );
  if (!incidents.length) return null;
  const control = async (
    id: string,
    action: 'release' | 'extend' | 'approve' | 'reject',
    holdId?: string,
  ) => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await stockProtectionApi.control({
        params: { organizationId },
        body: { id, action, ...(holdId ? { holdId } : {}) },
      });
      await query.refetch();
    } catch {
      setError(m.settings_protection_change_unconfirmed());
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label={m.settings_protection_title()}>
      {query.isError ? (
        <Alert tone="warning">{m.settings_protection_stale()}</Alert>
      ) : null}
      {error ? (
        <Alert role="alert" tone="warning">
          {error}
        </Alert>
      ) : null}
      {incidents.map((incident) => {
        const positions = incident.positions.filter(
          (p) =>
            (!positionId || p.positionId === positionId) &&
            (!skuId || p.skuId === skuId),
        );
        const held =
          incident.heldCount ??
          incident.positions.filter((p) => p.startedAt && !p.endedAt).length;

        return (
          <Alert
            key={incident.id}
            tone={
              incident.state === 'unknown' || incident.state === 'escalated'
                ? 'warning'
                : 'info'
            }
          >
            <AlertTitle>
              {incident.state === 'released'
                ? m.settings_protection_released_title({
                    store: incident.label,
                  })
                : incident.state === 'approval_required'
                  ? m.settings_protection_approval_title({
                      store: incident.label,
                    })
                  : incident.mode === 'preview'
                    ? m.settings_protection_preview_title({
                        store: incident.label,
                      })
                    : m.settings_protection_active_title({
                        store: incident.label,
                        count: formatNumber(held),
                      })}
            </AlertTitle>
            <p>{m.settings_protection_context()}</p>
            <p>
              {m.settings_protection_since({
                time: formatDateTime(incident.startedAt, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  timeZone,
                }),
              })}
            </p>
            {incident.endedAt ? (
              <p>
                {m.settings_protection_ended({
                  time: formatDateTime(incident.endedAt, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone,
                  }),
                })}
              </p>
            ) : null}
            <Link
              to="/app/$organizationId/exceptions/$exceptionId/detail"
              params={{ organizationId, exceptionId: incident.id }}
            >
              {m.settings_protection_open_incident()}
            </Link>
            {incident.state === 'escalated' ? (
              <p>{m.settings_protection_escalated()}</p>
            ) : null}
            {incident.state === 'unknown' ? (
              <p>{m.settings_protection_unknown()}</p>
            ) : null}
            {query.data!.canManage || incident.canApprove ? (
              <div className="settings-actions">
                {query.data!.canManage ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={pending || incident.state === 'released'}
                      onClick={() => void control(incident.id, 'release')}
                    >
                      {m.settings_protection_release_all()}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={pending || incident.state === 'released'}
                      onClick={() => void control(incident.id, 'extend')}
                    >
                      {m.settings_protection_extend()}
                    </Button>
                  </>
                ) : null}
                {incident.canApprove ? (
                  <>
                    <Button
                      disabled={pending}
                      onClick={() => void control(incident.id, 'approve')}
                    >
                      {m.settings_protection_approve_batch()}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => void control(incident.id, 'reject')}
                    >
                      {m.settings_protection_reject_batch()}
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
            {positionId || skuId
              ? positions
                  .filter((p) => p.startedAt && !p.endedAt)
                  .map((p) => (
                    <p key={p.id}>
                      <Badge>{status[p.status]()}</Badge>{' '}
                      {m.settings_protection_compare({
                        shown: quantity(p.current),
                        erp: quantity(p.authority),
                      })}
                    </p>
                  ))
              : null}
            {positions.length ? (
              <Disclosure>
                <summary>
                  {m.settings_protection_positions({
                    count: formatNumber(
                      incident.positionCount ?? positions.length,
                    ),
                  })}
                </summary>
                <DataTable<StockProtectionPosition>
                  caption={m.settings_protection_table()}
                  rows={positions}
                  rowKey={(p) => p.id}
                  columns={[
                    {
                      key: 'sku',
                      header: m.settings_protection_sku(),
                      cell: (p) => p.sku ?? p.title ?? m.common_unknown(),
                    },
                    {
                      key: 'authority',
                      header: m.settings_protection_erp(),
                      numeric: true,
                      cell: (p) => quantity(p.authority),
                    },
                    {
                      key: 'held',
                      header: m.settings_protection_held(),
                      numeric: true,
                      cell: (p) => quantity(p.held),
                    },
                    {
                      key: 'current',
                      header: m.settings_protection_shopify(),
                      numeric: true,
                      cell: (p) => quantity(p.current),
                    },
                    {
                      key: 'status',
                      header: m.settings_protection_status(),
                      cell: (p) => (
                        <>
                          <Badge>{status[p.status]()}</Badge>
                          {p.reason ? (
                            <p>
                              {(
                                reasons[p.reason] ??
                                m.settings_protection_reason_incomplete
                              )()}
                            </p>
                          ) : null}
                        </>
                      ),
                    },
                    ...(query.data!.canManage
                      ? [
                          {
                            key: 'release',
                            header: m.settings_protection_action(),
                            cell: (p: StockProtectionPosition) =>
                              p.startedAt && !p.endedAt ? (
                                <Button
                                  variant="outline"
                                  disabled={pending}
                                  onClick={() =>
                                    void control(incident.id, 'release', p.id)
                                  }
                                >
                                  {m.settings_protection_release_sku()}
                                </Button>
                              ) : null,
                          },
                        ]
                      : []),
                  ]}
                />
                <p>
                  {m.settings_protection_totals({
                    count: formatNumber(incident.protectedCount ?? 0),
                    minutes: formatNumber(
                      Math.max(
                        0,
                        Math.ceil(
                          ((incident.endedAt
                            ? Date.parse(incident.endedAt)
                            : query.dataUpdatedAt) -
                            Date.parse(incident.startedAt)) /
                            60000,
                        ),
                      ),
                    ),
                    skus: formatNumber(incident.exposedSkus ?? 0),
                  })}
                </p>
                <p>
                  {(incident.mode === 'preview'
                    ? m.settings_protection_preview_summary
                    : m.settings_protection_summary)({
                    hours: formatNumber(incident.unitHours ?? 0),
                    units: formatNumber(incident.exposedUnits ?? 0),
                  })}
                </p>
                {incidentId && (offset > 0 || incident.positionsTruncated) ? (
                  <div className="settings-actions">
                    <Button
                      variant="outline"
                      disabled={offset === 0 || query.isFetching}
                      onClick={() =>
                        setOffset((value) => Math.max(0, value - 50))
                      }
                    >
                      {m.common_previous()}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={
                        !incident.positionsTruncated || query.isFetching
                      }
                      onClick={() => setOffset((value) => value + 50)}
                    >
                      {m.common_next()}
                    </Button>
                  </div>
                ) : null}
              </Disclosure>
            ) : null}
          </Alert>
        );
      })}
    </section>
  );
}
