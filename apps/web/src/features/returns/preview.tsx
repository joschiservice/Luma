import type { ReturnListItem } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { PreviewFact } from '../../kit/collections/preview';
import {
  type CollectionValueFilter,
  ValueFilterMenu,
} from '../../kit/collections/value-filter';
import { formatQuantity } from '../../shared/orders/presentation';
import { returnsPresentation } from './collection';
import { returnOptions } from './data';
import { returnField, ReturnFlags, type ReturnSourceLabel } from './fields';
import { nextStep, refundLabels, stageLabels } from './presentation';

/** Items the preview lists before pointing to the full return. */
const previewLines = 5;

const label = (key: string) => returnsPresentation[key]?.label() ?? key;

/**
 * A compact summary of the return open beside the list: its stage and who owns the next step,
 * money and dates from the list row, then the returned items from the return's detail read.
 * `filter` offers "Show only this value" and "Hide this value" on the stage, refund state,
 * source and each reason. The store owns the stage, so the preview never changes it.
 */
export function ReturnPreview({
  organizationId,
  item,
  returnId,
  sourceLabel,
  sourceSystem,
  filter,
}: {
  organizationId: string;
  /** The return's list row, when it is on the current page. */
  item: ReturnListItem | undefined;
  returnId: string;
  sourceLabel: ReturnSourceLabel;
  /** The system of a source, for wording the next step. */
  sourceSystem: (connectionId: string) => string | null;
  filter?: CollectionValueFilter | undefined;
}) {
  const detail = useQuery(returnOptions(organizationId, returnId));
  const shown = item ?? detail.data?.item;
  const menu = (field: string, value: string, text: string) =>
    filter ? (
      <ValueFilterMenu
        className="return-preview-filter"
        field={field}
        value={value}
        label={m.returns_preview_filter({ value: text })}
        filter={filter}
      />
    ) : null;
  const lines = detail.data?.lines ?? [];

  return (
    <div className="collection-preview-body">
      {shown ? (
        <>
          <ReturnFlags item={shown} />
          <p className="returns-note">
            {nextStep(shown, sourceSystem(shown.connectionId))}
          </p>
          <dl className="collection-preview-facts">
            <PreviewFact
              label={label('stage')}
              menu={menu('stage', shown.stage, stageLabels[shown.stage])}
            >
              {stageLabels[shown.stage]}
            </PreviewFact>
            <PreviewFact
              label={label('refundState')}
              menu={menu(
                'refundState',
                shown.refund.state,
                refundLabels[shown.refund.state],
              )}
            >
              {returnField(shown, 'refund', sourceLabel)}
            </PreviewFact>
            {(['items', 'value', 'requested', 'activity'] as const).map(
              (key) => (
                <PreviewFact key={key} label={label(key)}>
                  {returnField(shown, key, sourceLabel)}
                </PreviewFact>
              ),
            )}
            <PreviewFact
              label={label('source')}
              menu={menu(
                'source',
                shown.connectionId,
                sourceLabel(shown.connectionId),
              )}
            >
              {sourceLabel(shown.connectionId)}
            </PreviewFact>
            <PreviewFact label={m.returns_preview_order()}>
              <Link
                to="/app/$organizationId/orders/$orderId"
                params={{ organizationId, orderId: shown.order.id }}
              >
                {shown.order.displayNumber ?? shown.order.id.slice(0, 8)}
              </Link>
            </PreviewFact>
            {shown.reasons.length ? (
              <PreviewFact label={label('reasons')}>
                <span className="return-preview-reasons">
                  {shown.reasons.map((reason) => (
                    <span key={reason}>
                      {reason}
                      {menu('reasons', reason, reason)}
                    </span>
                  ))}
                </span>
              </PreviewFact>
            ) : null}
          </dl>
        </>
      ) : null}
      {detail.isPending ? (
        <p role="status" className="returns-muted">
          {m.returns_detail_loading()}
        </p>
      ) : detail.isError ? (
        <Alert role="status">{m.returns_preview_unavailable()}</Alert>
      ) : lines.length ? (
        <section>
          <h3 className="collection-preview-heading">
            {m.returns_preview_items()}
          </h3>
          <ul className="collection-preview-lines">
            {lines.slice(0, previewLines).map((line, index) => (
              <li key={line.orderLineId ?? index}>
                <span>
                  {line.title ?? line.skuCode ?? m.common_empty_value()}
                </span>
                <span>{formatQuantity(line.quantity, line.unit)}</span>
              </li>
            ))}
          </ul>
          {lines.length > previewLines ? (
            <p className="returns-muted">
              {m.common_count_more({ count: lines.length - previewLines })}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
