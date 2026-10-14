import type { FulfillmentItem, FulfillmentList } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { useQuery } from '@tanstack/react-query';

import { PreviewFact } from '../../kit/collections/preview';
import {
  type CollectionValueFilter,
  ValueFilterMenu,
} from '../../kit/collections/value-filter';
import { fulfillmentPresentation } from './collection';
import { fulfillmentOptions } from './data';
import {
  carriers,
  fulfillmentField,
  type FulfillmentFieldContext,
  FulfillmentFlags,
} from './fields';
import { diagnosis, nextStep, quantity } from './presentation';

/** Items the preview lists before pointing to the full fulfillment. */
const previewLines = 5;

const label = (key: string) => fulfillmentPresentation[key]?.label() ?? key;

/**
 * A compact summary of the fulfillment open beside the list: its state and key facts from the
 * list row, then what blocks it, the next safe step and its first items from the detail read.
 * `filter` offers "Show only this value" and "Hide this value" on status, type, source, location
 * and carrier.
 */
export function FulfillmentPreview({
  organizationId,
  fulfillmentId,
  item,
  sources,
  asOf,
  filter,
}: {
  organizationId: string;
  fulfillmentId: string;
  /** The fulfillment's list row, when it is on the current page. */
  item: FulfillmentItem | undefined;
  sources: FulfillmentList['sources'];
  /** When the list was read, for relative times until the detail arrives. */
  asOf: string;
  filter?: CollectionValueFilter | undefined;
}) {
  const detail = useQuery(fulfillmentOptions(organizationId, fulfillmentId));
  const shown = item ?? detail.data?.item;
  const context: FulfillmentFieldContext = {
    sources: detail.data
      ? [
          ...sources,
          ...(sources.some(
            (source) => source.connectionId === detail.data.source.connectionId,
          )
            ? []
            : [detail.data.source]),
        ]
      : sources,
    asOf: detail.data?.asOf ?? asOf,
  };
  const menu = (field: string, value: string, text: string) =>
    filter ? (
      <ValueFilterMenu
        field={field}
        value={value}
        label={m.fulfillment_preview_filter({ value: text })}
        filter={filter}
      />
    ) : null;
  const fact = (key: string, value?: string) => {
    const text = shown ? fulfillmentField(shown, key, context) : null;

    return (
      <PreviewFact
        key={key}
        label={label(key)}
        menu={
          value && typeof text === 'string' ? menu(key, value, text) : undefined
        }
      >
        {text}
      </PreviewFact>
    );
  };
  const summary = detail.data
    ? diagnosis(detail.data.item, detail.data.asOf)
    : null;
  const step = detail.data ? nextStep(detail.data, false) : null;

  return (
    <div className="collection-preview-body">
      {shown ? (
        <>
          <FulfillmentFlags item={shown} />
          <dl className="collection-preview-facts">
            {fact('status', shown.status)}
            {fact('kind', shown.kind === 'unknown' ? undefined : shown.kind)}
            {fact('source', shown.connectionId)}
            {fact('location', shown.location?.id ?? undefined)}
            {fact('method')}
            <PreviewFact label={label('carrier')}>
              {carriers(shown).length ? (
                <span className="fulfillment-preview-carriers">
                  {carriers(shown).map((carrier) => (
                    <span key={carrier}>
                      {carrier}
                      {menu('carrier', carrier, carrier)}
                    </span>
                  ))}
                </span>
              ) : (
                fulfillmentField(shown, 'carrier', context)
              )}
            </PreviewFact>
            {fact('fulfillBy')}
            {fact('estimatedDelivery')}
            {fact('progress')}
            {fact('orderPlaced')}
          </dl>
        </>
      ) : null}
      {detail.data && summary && step ? (
        <>
          <section>
            <h3 className="collection-preview-heading">{summary.title}</h3>
            <p className="collection-preview-note">{summary.body}</p>
          </section>
          <section>
            <h3 className="collection-preview-heading">{step.title}</h3>
            <p className="collection-preview-note">{step.body}</p>
          </section>
          {detail.data.lines.length ? (
            <section>
              <h3 className="collection-preview-heading">
                {m.fulfillment_preview_items()}
              </h3>
              <ul className="collection-preview-lines">
                {detail.data.lines.slice(0, previewLines).map((line) => (
                  <li key={line.orderLineId}>
                    <span>
                      {line.title ?? line.skuCode ?? m.common_empty_value()}
                    </span>
                    <span>{quantity(line.quantity, line.unit)}</span>
                  </li>
                ))}
              </ul>
              {detail.data.lines.length > previewLines ? (
                <p className="collection-preview-note">
                  {m.common_count_more({
                    count: detail.data.lines.length - previewLines,
                  })}
                </p>
              ) : detail.isPending ? (
                <p role="status" className="collection-preview-note">
                  {m.fulfillment_detail_loading()}
                </p>
              ) : detail.isError ? (
                <Alert role="status">
                  {m.fulfillment_preview_unavailable()}
                </Alert>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
