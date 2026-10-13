import type { ActionDiff as Diff } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { useId } from 'react';

import { Badge } from '../primitives/badge';
import { Button } from '../primitives/button';
import { DataTable } from '../primitives/data-table';
import { Disclosure } from '../primitives/disclosure';
import { WorkspaceDate } from '../primitives/workspace-date';

const labels: Record<string, () => string> = {
  order: m.issues_diff_label_order,
  order_line: m.issues_diff_label_order_line,
  location: m.issues_diff_label_location,
  customer: m.issues_diff_label_customer,
  listing: m.issues_diff_label_listing,
  inventory_item: m.issues_diff_label_inventory_item,
  position: m.issues_diff_label_position,
  sku: m.issues_diff_label_sku,
  product: m.issues_diff_label_product,
  supplier: m.issues_diff_label_supplier,
  purchase_order: m.issues_diff_label_purchase_order,
  return: m.issues_diff_label_return,
  return_case: m.issues_diff_label_return_case,
  fulfillment_order: m.issues_diff_label_fulfillment_order,
  message: m.issues_diff_label_message,
  available: m.issues_diff_label_available,
  quantity: m.issues_diff_label_quantity,
  shippingMethodId: m.issues_diff_label_shipping_method_id,
  valueJson: m.issues_diff_label_value_json,
  status: m.issues_diff_label_status,
  revision: m.issues_diff_label_revision,
  projection: m.issues_diff_label_projection,
  recorded: m.issues_diff_label_recorded,
  locationId: m.issues_diff_label_location_id,
  holdId: m.issues_diff_label_hold_id,
  requestedDeliveryDate: m.issues_diff_label_requested_delivery_date,
  reference: m.issues_diff_label_reference,
  recipients: m.issues_diff_label_recipients,
  contentDigest: m.issues_diff_label_content_digest,
  fieldId: m.issues_diff_label_field_id,
  nextCheckAt: m.issues_diff_label_next_check_at,
  key: m.issues_diff_label_key,
  restock: m.issues_diff_label_restock,
  present: m.issues_diff_label_present,
  amount: m.issues_diff_label_amount,
  currency: m.issues_diff_label_currency,
  onHand: m.issues_diff_label_on_hand,
  returnId: m.issues_diff_label_return_id,
  fulfillmentOrderId: m.issues_diff_label_fulfillment_order_id,
  kind: m.issues_diff_label_kind,
  operationId: m.issues_diff_label_operation_id,
  stepId: m.issues_diff_label_step_id,
  lineQuantities: m.issues_diff_label_line_quantities,
  trackingNumber: m.issues_diff_label_tracking_number,
  trackingUrl: m.issues_diff_label_tracking_url,
  carrier: m.issues_diff_label_carrier,
  skuId: m.issues_diff_label_sku_id,
  variantId: m.issues_diff_label_variant_id,
  replacement: m.issues_diff_label_replacement,
  financial: m.issues_diff_label_financial,
};

const label = (key: string) =>
  labels[key]?.() ??
  key.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

function fieldLabel(field: string) {
  const line = /^lines\[(.+)\]\.(.+)$/.exec(field);
  if (line) return `${label('order_line')} ${line[1]} · ${label(line[2]!)}`;
  const hold = /^holds\[(.+)\]\.(.+)$/.exec(field);
  if (hold) return `${label('holdId')} ${hold[1]} · ${label(hold[2]!)}`;

  return field.split('.').map(label).join(' · ');
}

const value = (known: boolean, input: string | number | boolean | null) =>
  !known
    ? m.issues_diff_unknown()
    : input === null
      ? m.issues_diff_null()
      : typeof input === 'number'
        ? formatNumber(input)
        : typeof input === 'boolean'
          ? input
            ? m.issues_diff_yes()
            : m.issues_diff_no()
          : String(input);

/** Shows the exact immutable change, expected values and known limits without granting authority. */
export function ActionDiff({
  diff,
  onEvidence,
}: {
  diff: Diff;
  onEvidence?: (() => void) | undefined;
}) {
  const id = useId();
  const reversibility = {
    reversible: m.issues_diff_reversible,
    compensatable: m.issues_diff_compensatable,
    irreversible: m.issues_diff_irreversible,
    unknown: m.issues_diff_reversibility_unknown,
  };

  return (
    <section className="action-diff" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{m.issues_diff_title()}</h4>
      <Badge
        tone={diff.reversibility === 'irreversible' ? 'warning' : 'neutral'}
      >
        {reversibility[diff.reversibility]()}
      </Badge>
      {diff.records.map((record) => (
        <Disclosure key={`${record.system}:${record.id}`} open>
          <summary>
            {record.system === 'luma'
              ? m.issues_diff_luma()
              : m.issues_diff_provider()}{' '}
            · {label(record.kind)} · {record.id ?? m.issues_diff_unknown()}
          </summary>
          {record.link ? (
            <a href={record.link}>{m.issues_diff_open_record()}</a>
          ) : null}
          <DataTable
            caption={m.issues_diff_title()}
            density="compact"
            variant="plain"
            rows={record.changes}
            rowKey={(change) => change.field}
            columns={[
              {
                key: 'field',
                header: m.issues_diff_field(),
                cell: (change) => fieldLabel(change.field),
              },
              {
                key: 'before',
                header: m.issues_diff_before(),
                cell: (change) => value(change.beforeKnown, change.before),
              },
              {
                key: 'after',
                header: m.issues_diff_after(),
                cell: (change) => value(change.afterKnown, change.after),
              },
              {
                key: 'expected',
                header: m.issues_diff_expected(),
                cell: (change) => value(change.expectedKnown, change.expected),
              },
            ]}
          />
        </Disclosure>
      ))}
      <dl className="action-diff-facts">
        <div>
          <dt>{m.issues_diff_policy()}</dt>
          <dd>
            {diff.policy ? (
              <>
                <span>
                  {{
                    allowed: m.issues_policy_allowed,
                    denied: m.issues_policy_denied,
                    approval_required: m.issues_policy_approval_required,
                  }[diff.policy.outcome]()}
                </span>
                <span>
                  {diff.policy.current
                    ? m.issues_diff_policy_current()
                    : m.issues_diff_policy_recorded()}
                </span>
              </>
            ) : (
              m.issues_diff_unknown()
            )}
          </dd>
        </div>
        <div>
          <dt>{m.issues_diff_scope()}</dt>
          <dd>
            {diff.scope.map((scope) => (
              <span key={scope.kind}>
                {label(scope.kind)}:{' '}
                {scope.count === null
                  ? m.issues_diff_unknown()
                  : formatNumber(scope.count)}
                {scope.ids.length ? ` (${scope.ids.join(', ')})` : ''}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt>{m.issues_diff_age()}</dt>
          <dd>
            {diff.evidence.ageSeconds === undefined ||
            diff.evidence.ageSeconds === null
              ? m.issues_diff_unknown()
              : m.issues_diff_age_seconds({ count: diff.evidence.ageSeconds })}
          </dd>
        </div>
        <div>
          <dt>{m.issues_diff_observed()}</dt>
          <dd>
            {diff.evidence.observedAt ? (
              <WorkspaceDate value={diff.evidence.observedAt} />
            ) : (
              m.issues_diff_unknown()
            )}
          </dd>
        </div>
        <div>
          <dt>{m.issues_diff_valid_until()}</dt>
          <dd>
            <WorkspaceDate value={diff.evidence.validUntil} />
          </dd>
        </div>
      </dl>
      <Disclosure>
        <summary>
          {m.issues_diff_evidence({ count: diff.evidence.refs.length })}
        </summary>
        <ul>
          {diff.evidence.refs.map((ref) => (
            <li key={ref}>
              <code>{ref}</code>
            </li>
          ))}
        </ul>
      </Disclosure>
      {onEvidence ? (
        <Button variant="ghost" onClick={onEvidence}>
          {m.issues_diff_open_evidence()}
        </Button>
      ) : diff.evidence.link ? (
        <a href={diff.evidence.link}>{m.issues_diff_open_evidence()}</a>
      ) : null}
      <p>{m.issues_diff_retry()}</p>
      {diff.canonicalOutcome === 'requires_fresh_verification' ? (
        <p>
          {m.issues_diff_verification()} {m.issues_diff_canonical_unknown()}
        </p>
      ) : (
        <p>{m.issues_diff_internal()}</p>
      )}
    </section>
  );
}
