import type { CustomerListItem } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';

import { PreviewFact } from '../../kit/collections/preview';
import {
  type CollectionValueFilter,
  ValueFilterMenu,
} from '../../kit/collections/value-filter';
import { customersPresentation } from './collection';
import { customerOptions } from './data';
import {
  customerField,
  CustomerFlags,
  type CustomerSourceLabel,
} from './fields';
import { addressLines, stateLabels } from './presentation';

const label = (key: string) => customersPresentation[key]?.label() ?? key;

/**
 * A compact summary of the customer open beside the list: whether the source still has them,
 * account, source, order facts and contact details from the list row, then the shared address
 * and Luma's last read from the customer's detail read. `filter` offers "Show only this value"
 * and "Hide this value" on the account, source, country and each tag.
 */
export function CustomerPreview({
  organizationId,
  customer,
  customerId,
  sourceLabel,
  filter,
}: {
  organizationId: string;
  /** The customer's list row, when it is on the current page. */
  customer: CustomerListItem | undefined;
  customerId: string;
  sourceLabel: CustomerSourceLabel;
  filter?: CollectionValueFilter | undefined;
}) {
  const detail = useQuery(customerOptions(organizationId, customerId));
  const shown = customer ?? detail.data?.item;
  const menu = (field: string, value: string, text: string) =>
    filter ? (
      <ValueFilterMenu
        className="customer-preview-filter"
        field={field}
        value={value}
        label={m.customers_preview_filter({ value: text })}
        filter={filter}
      />
    ) : null;
  const address = addressLines(detail.data?.address ?? null);

  return (
    <div className="collection-preview-body">
      {shown ? (
        <>
          <CustomerFlags customer={shown} sourceLabel={sourceLabel} />
          <dl className="collection-preview-facts">
            <PreviewFact
              label={label('state')}
              menu={menu('state', shown.state, stateLabels[shown.state])}
            >
              {stateLabels[shown.state]}
            </PreviewFact>
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
            {(['orders', 'spent', 'created'] as const).map((key) => (
              <PreviewFact key={key} label={label(key)}>
                {customerField(shown, key, sourceLabel)}
              </PreviewFact>
            ))}
            {shown.lastOrderAt !== undefined ? (
              <PreviewFact label={label('lastOrder')}>
                {customerField(shown, 'lastOrder', sourceLabel)}
              </PreviewFact>
            ) : null}
            {(['email', 'phone'] as const).map((key) => (
              <PreviewFact key={key} label={label(key)}>
                {customerField(shown, key, sourceLabel)}
              </PreviewFact>
            ))}
            <PreviewFact
              label={label('country')}
              menu={
                shown.shared.address && shown.country
                  ? menu('country', shown.country, shown.country)
                  : null
              }
            >
              {customerField(shown, 'country', sourceLabel)}
            </PreviewFact>
            {shown.tags.length ? (
              <PreviewFact label={label('tags')}>
                <span className="customer-preview-tags">
                  {shown.tags.map((tag) => (
                    <span key={tag}>
                      {tag}
                      {menu('tags', tag, tag)}
                    </span>
                  ))}
                </span>
              </PreviewFact>
            ) : null}
          </dl>
        </>
      ) : null}
      {detail.isPending ? (
        <p role="status" className="customers-muted">
          {m.customers_detail_loading()}
        </p>
      ) : detail.isError ? (
        <Alert role="status">{m.customers_preview_unavailable()}</Alert>
      ) : detail.data ? (
        <dl className="collection-preview-facts">
          <PreviewFact label={m.customers_fact_address()}>
            {address ? (
              address.map((line) => (
                <span key={line} className="customers-line">
                  {line}
                </span>
              ))
            ) : (
              <span className="customers-muted">
                {detail.data.item.shared.address
                  ? m.common_empty_value()
                  : m.customers_not_shared()}
              </span>
            )}
          </PreviewFact>
          <PreviewFact label={m.customers_fact_read()}>
            <WorkspaceDate value={detail.data.item.observedAt} />
          </PreviewFact>
        </dl>
      ) : null}
    </div>
  );
}
