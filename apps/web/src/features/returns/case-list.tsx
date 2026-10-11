import './returns.css';

import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { StatePill } from '@luma/ui/components/primitives/state';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { IdentityError } from '../../kit/identity/data';
import { returnCasesOptions } from './case-data';
import {
  caseStageLabels,
  caseStageStates,
  personName,
} from './case-presentation';

/** Lists a customer's source-mapped cases with bounded paging and accurate load/access states. */
export function CustomerReturnCases({
  organizationId,
  customerId,
}: {
  organizationId: string;
  customerId: string;
}) {
  const [cursor, setCursor] = useState<string>();
  const query = useQuery(
    returnCasesOptions(organizationId, {
      customerId,
      ...(cursor ? { cursor } : {}),
    }),
  );
  if (query.error instanceof IdentityError && query.error.status === 403)
    return null;

  return (
    <Card as="section" aria-label={m.returns_service_cases()}>
      <CardHeader>
        <CardTitle as="h2">{m.returns_service_cases()}</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isError ? (
          <Alert tone="danger">
            {m.returns_case_load_failed()}{' '}
            <Button variant="outline" onClick={() => void query.refetch()}>
              {m.common_retry()}
            </Button>
          </Alert>
        ) : query.isPending ? (
          <p role="status">{m.returns_case_loading()}</p>
        ) : (
          <>
            {!query.data.items.length ? (
              <p>{m.returns_service_no_cases()}</p>
            ) : (
              <ul className="order-return-cases">
                {query.data.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      className="order-row-link"
                      to="/app/$organizationId/returns/cases/$caseId"
                      params={{ organizationId, caseId: item.id }}
                    >
                      <span className="returns-cell">
                        <strong>
                          {m.returns_case_title({
                            order: item.orderNumber ?? item.orderId.slice(0, 8),
                          })}
                        </strong>
                        <StatePill state={caseStageStates[item.stage]}>
                          {caseStageLabels[item.stage]}
                        </StatePill>
                        <small>
                          {item.assignee
                            ? personName(item.assignee)
                            : m.returns_service_unassigned()}
                        </small>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {cursor ? (
              <Button variant="outline" onClick={() => setCursor(undefined)}>
                {m.orders_list_first_page()}
              </Button>
            ) : null}
            {query.data.nextCursor ? (
              <Button
                variant="outline"
                onClick={() => setCursor(query.data.nextCursor!)}
              >
                {m.common_next()}
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
