import type { AppUiProps } from '@luma/app-host/web';
import { m } from '@luma/i18n/messages';
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

const issueStates: Record<string, () => string> = {
  detected: m.shopify_issue_state_detected,
  diagnosed: m.shopify_issue_state_diagnosed,
  proposed: m.shopify_issue_state_proposed,
  awaiting_approval: m.shopify_issue_state_awaiting_approval,
  allowed: m.shopify_issue_state_allowed,
  executing: m.shopify_issue_state_executing,
  verifying: m.shopify_issue_state_verifying,
  failed: m.shopify_issue_state_failed,
  escalated: m.shopify_issue_state_escalated,
};

const relationships = {
  sku: m.shopify_order_relationship_sku,
  order: m.shopify_order_relationship_order,
  fulfillment: m.shopify_order_relationship_fulfillment,
} satisfies Record<'sku' | 'order' | 'fulfillment', () => string>;

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
    <Card as="section" variant="subtle" aria-label={m.shopify_order_label()}>
      <CardHeader>
        <CardTitle as="h3">
          {m.shopify_order_title({
            order: String(
              read.data?.sections.find((section) => section.key === 'order')
                ?.rows[0]?.fields.Name ?? m.shopify_order_fallback_name(),
            ),
          })}
        </CardTitle>
        {read.data ? (
          <span className="field-help">{read.data.shop}</span>
        ) : null}
      </CardHeader>
      <CardContent>
        {read.pending ? (
          <p role="status">{m.shopify_order_loading()}</p>
        ) : read.error ? (
          <Alert role="alert">
            {read.error}{' '}
            <Button variant="outline" onClick={read.refresh}>
              {m.common_retry()}
            </Button>
          </Alert>
        ) : read.data ? (
          <div className="customer-order-body">
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
                {m.shopify_order_luma_failed({ error })}{' '}
                <Button variant="outline" onClick={read.refresh}>
                  {m.common_retry()}
                </Button>
              </Alert>
            ) : context?.status === 'ambiguous' ? (
              <Alert role="status">{m.shopify_order_ambiguous()}</Alert>
            ) : context?.status === 'unmapped' ? (
              <Alert>{m.shopify_order_unmapped()}</Alert>
            ) : !services.orderContext ? (
              <p className="field-help">{m.shopify_order_luma_unavailable()}</p>
            ) : !context ? (
              <p role="status">{m.shopify_order_resolving()}</p>
            ) : order ? (
              <>
                <a href={`${base}/orders/${order.order.id}`}>
                  {order.order.displayNumber
                    ? m.shopify_order_open_in_luma({
                        order: order.order.displayNumber,
                      })
                    : m.shopify_order_open_in_luma_unnamed()}
                </a>
                <section>
                  <h4>{m.shopify_order_issues_title()}</h4>
                  {issues.length ? (
                    <ul className="customer-linked-work">
                      {issues.map((issue) => (
                        <li key={issue.id}>
                          <a href={`${base}/exceptions/${issue.id}`}>
                            {issueKind(issue).label}
                          </a>
                          {issue.needsYou ? (
                            <StatePill state="attention">
                              {m.shopify_order_needs_you()}
                            </StatePill>
                          ) : (
                            <span className="field-help">
                              {issueStates[issue.state]?.() ??
                                issue.state.replaceAll('_', ' ')}
                            </span>
                          )}
                          <span className="field-help">
                            {relationships[issue.relationship]()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="field-help">
                      {m.shopify_order_issues_empty()}
                    </p>
                  )}
                </section>
                <section>
                  <h4>{m.shopify_order_actions_title()}</h4>
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
                      {m.shopify_order_actions_empty()}
                    </p>
                  )}
                  {order.activity.truncated ? (
                    <a href={`${base}/activity`}>
                      {m.shopify_order_activity_link()}
                    </a>
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
