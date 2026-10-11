import type { OrderReturnCases, ReturnCaseReason } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { openReturnCase } from './case-data';
import { CaseDialog, UnitsField, useCaseCommand } from './case-dialogs';
import { reasonLabels } from './case-presentation';

const reasons: ReturnCaseReason[] = [
  'damaged',
  'defective',
  'wrong_item',
  'not_as_described',
  'size_or_fit',
  'no_longer_needed',
  'other',
];

/** A store return the new case works, with the units it lists per order line. */
export interface CaseStoreReturn {
  id: string;
  connectionId: string;
  lines: { orderLineId: string; quantity: number; reason: string | null }[];
}

/**
 * Opens a return case on lines of one source of an order. From a store return, the case works
 * that return: its lines are prefilled and its units count only through the case.
 */
export function OpenCaseDialog({
  organizationId,
  orderId,
  cases,
  sourceLabel,
  storeReturn,
  close,
}: {
  organizationId: string;
  orderId: string;
  cases: OrderReturnCases;
  sourceLabel: (connectionId: string) => string;
  storeReturn?: CaseStoreReturn | undefined;
  close: () => void;
}) {
  const navigate = useNavigate();
  const [id] = useState(() => crypto.randomUUID());
  const sources = storeReturn
    ? cases.sources.filter((s) => s.connectionId === storeReturn.connectionId)
    : cases.sources.filter((s) => s.lines.some((l) => l.returnable > 0));
  const [connectionId, setConnectionId] = useState(
    () => sources[0]?.connectionId ?? null,
  );
  const source = sources.find((s) => s.connectionId === connectionId);
  // A linked store return's own units are available to the case that works it.
  const linked = (orderLineId: string) =>
    storeReturn?.lines
      .filter((l) => l.orderLineId === orderLineId)
      .reduce((sum, l) => sum + l.quantity, 0) ?? 0;
  const lines = (source?.lines ?? [])
    .map((line) => ({
      ...line,
      max: Math.floor(line.returnable + linked(line.orderLineId)),
    }))
    .filter((line) => line.max > 0);

  type Choice = {
    include: boolean;
    quantity: number;
    reason: ReturnCaseReason;
    note: string;
  };

  const defaults = (line: (typeof lines)[number]): Choice => {
    const prefill = storeReturn?.lines.find(
      (l) => l.orderLineId === line.orderLineId,
    );

    return {
      include: !storeReturn || !!prefill,
      quantity: Math.min(line.max, prefill?.quantity ?? 1),
      reason: 'other',
      note: prefill?.reason ?? '',
    };
  };
  // Only changed lines are stored, so switching the source starts from its defaults.
  const [changes, setChanges] = useState<Record<string, Partial<Choice>>>({});
  const choice = (line: (typeof lines)[number]): Choice => ({
    ...defaults(line),
    ...changes[line.orderLineId],
  });
  const command = useCaseCommand(
    organizationId,
    (body: Parameters<typeof openReturnCase>[2]) =>
      openReturnCase(organizationId, orderId, body),
    (detail) => {
      close();
      void navigate({
        to: '/app/$organizationId/returns/cases/$caseId',
        params: { organizationId, caseId: detail.case.id },
      });
    },
  );
  const included = lines.filter((line) => choice(line).include);
  const update = (orderLineId: string, patch: Partial<Choice>) =>
    setChanges((current) => ({
      ...current,
      [orderLineId]: { ...current[orderLineId], ...patch },
    }));

  return (
    <CaseDialog
      title={m.returns_case_open_title()}
      description={
        storeReturn
          ? m.returns_case_open_description_store()
          : m.returns_case_open_description()
      }
      command={command}
      close={close}
      label={m.returns_case_open_save()}
      pending={m.returns_case_saving()}
      disabled={!connectionId || !included.length}
      submit={() =>
        connectionId
          ? command.submit({
              id,
              connectionId,
              sourceReturnId: storeReturn?.id ?? null,
              lines: included.map((line) => {
                const value = choice(line);

                return {
                  orderLineId: line.orderLineId,
                  quantity: value.quantity,
                  reason: value.reason,
                  note: value.note.trim() || null,
                };
              }),
            })
          : undefined
      }
    >
      {sources.length > 1 ? (
        <label>
          {m.returns_case_open_source()}
          <Select
            aria-label={m.returns_case_open_source()}
            value={connectionId}
            onValueChange={setConnectionId}
            options={sources.map((s) => ({
              value: s.connectionId,
              label: sourceLabel(s.connectionId),
            }))}
          />
        </label>
      ) : null}
      {lines.length ? (
        <ul className="returns-case-lines">
          {lines.map((line) => {
            const value = choice(line);

            return (
              <li key={line.orderLineId} data-included={value.include}>
                <label className="returns-case-include">
                  <input
                    type="checkbox"
                    checked={value.include}
                    onChange={(event) =>
                      update(line.orderLineId, {
                        include: event.target.checked,
                      })
                    }
                  />
                  <span className="returns-cell">
                    <strong>
                      {line.title ?? line.sku ?? m.returns_refunds_order_line()}
                    </strong>
                    <small>
                      {m.returns_case_open_returnable({
                        returnable: line.max,
                        ordered: line.ordered,
                      })}
                    </small>
                  </span>
                </label>
                {value.include ? (
                  <div className="returns-case-line-fields">
                    <UnitsField
                      label={m.returns_case_open_units()}
                      value={value.quantity}
                      max={line.max}
                      onChange={(quantity) =>
                        update(line.orderLineId, { quantity })
                      }
                    />
                    <label>
                      <span>{m.returns_case_open_reason()}</span>
                      <Select
                        aria-label={m.returns_case_open_reason()}
                        value={value.reason}
                        onValueChange={(reason) =>
                          update(line.orderLineId, {
                            reason: reason ?? 'other',
                          })
                        }
                        options={reasons.map((reason) => ({
                          value: reason,
                          label: reasonLabels[reason],
                        }))}
                      />
                    </label>
                    <label>
                      <span>
                        {m.returns_case_open_note()}{' '}
                        <span>{m.common_optional()}</span>
                      </span>
                      <Input
                        value={value.note}
                        maxLength={2000}
                        onChange={(event) =>
                          update(line.orderLineId, { note: event.target.value })
                        }
                      />
                    </label>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="returns-note">{m.returns_case_open_nothing()}</p>
      )}
    </CaseDialog>
  );
}
