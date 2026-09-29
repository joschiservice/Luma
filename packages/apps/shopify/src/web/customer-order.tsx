import type { AppUiProps } from '@luma/app-host/web';
import { issueKind } from '@luma/ui/components/issues/case-presentation';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { StatePill } from '@luma/ui/components/primitives/state';
import { useEffect, useState } from 'react';

import { useCustomerRecord } from './customer-data.js';
import { ShopifyRecordSections } from './sections.js';

type Context = Awaited<
  ReturnType<NonNullable<AppUiProps['services']['orderContext']>>
>;

/** Inspects one customer's source order and its exact canonical mapping without guessing a match. */
export function CustomerOrder({
  organizationId,
  connectionId,
  id,
  services,
}: {
  organizationId: string;
  connectionId: string;
  id: string;
  services: AppUiProps['services'];
}) {
  const read = useCustomerRecord(services, { connectionId, kind: 'Order', id });
  const [context, setContext] = useState<Context>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setContext(undefined);
    setError('');
    if (!read.data || !services.orderContext) return;
    services
      .orderContext(connectionId, id)
      .then((value) => {
        if (active) setContext(value);
      })
      .catch((cause) => {
        if (active) setError(services.error(cause));
      });

    return () => {
      active = false;
    };
  }, [services, connectionId, id, read.data]);
  const order = context?.order;
  const issues =
    order?.issues.filter((issue) => issue.state !== 'resolved') ?? [];
  const base = `/app/${encodeURIComponent(organizationId)}`;

  return (
    <Card as="section" aria-label="Selected order service context">
      <CardHeader>
        <CardTitle as="h3">
          {String(
            read.data?.sections.find((section) => section.key === 'order')
              ?.rows[0]?.fields.Name ?? 'Order',
          )}{' '}
          · Service context
        </CardTitle>
        {read.data ? (
          <span className="field-help">{read.data.shop}</span>
        ) : null}
      </CardHeader>
      <CardContent>
        {read.pending ? (
          <p role="status">Loading service context…</p>
        ) : read.error ? (
          <Alert role="alert">
            {read.error}{' '}
            <Button variant="outline" onClick={read.refresh}>
              Retry
            </Button>
          </Alert>
        ) : read.data ? (
          <div className="customer-workspace">
            <ShopifyRecordSections
              detail={{
                ...read.data,
                sections: read.data.sections.filter((section) =>
                  ['fulfillment', 'returns', 'refunds', 'history'].includes(
                    section.key,
                  ),
                ),
              }}
              headingLevel={4}
            />
            {error ? (
              <Alert role="alert">
                Luma context could not be loaded. {error}{' '}
                <Button variant="outline" onClick={read.refresh}>
                  Retry
                </Button>
              </Alert>
            ) : context?.status === 'ambiguous' ? (
              <Alert role="status">
                This source order has more than one Luma mapping. Its issues and
                actions cannot be attributed to a single order.
              </Alert>
            ) : context?.status === 'unmapped' ? (
              <Alert>
                This source order has not been mapped to a Luma order. Source
                history is shown above.
              </Alert>
            ) : !services.orderContext ? (
              <p className="field-help">
                Luma context is unavailable in this view.
              </p>
            ) : !context ? (
              <p role="status">Resolving Luma order…</p>
            ) : order ? (
              <>
                <a href={`${base}/orders/${order.order.id}`}>
                  Open {order.order.displayNumber ?? 'order'} in Luma →
                </a>
                <section>
                  <h4>Open issues</h4>
                  {issues.length ? (
                    <ul className="customer-linked-work">
                      {issues.map((issue) => (
                        <li key={issue.id}>
                          <a href={`${base}/exceptions/${issue.id}`}>
                            {issueKind(issue).label}
                          </a>
                          {issue.needsYou ? (
                            <StatePill state="attention">Needs you</StatePill>
                          ) : (
                            <span className="field-help">
                              {issue.state.replaceAll('_', ' ')}
                            </span>
                          )}
                          <span className="field-help">
                            {issue.relationship === 'sku'
                              ? 'Related SKU'
                              : 'Order / fulfillment'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="field-help">
                      No open issues in the available order context.
                    </p>
                  )}
                </section>
                <section>
                  <h4>Luma actions</h4>
                  {order.activity.entries.length ? (
                    <ul className="customer-linked-work">
                      {order.activity.entries.map((entry) => (
                        <li key={entry.id}>
                          <span>{entry.summary ?? entry.action}</span>
                          <span className="field-help">{entry.outcome}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="field-help">
                      No Luma actions recorded in the available history.
                    </p>
                  )}
                  {order.activity.truncated ? (
                    <a href={`${base}/activity`}>See more activity</a>
                  ) : null}
                </section>
              </>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
