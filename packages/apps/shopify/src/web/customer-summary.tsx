import { Badge } from '@luma/ui/components/primitives/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';

import type { ShopifyRecordDetail } from '../domain/records.js';

/** Shows source identity and separates withheld contact fields from fields the source did not provide. */
export function CustomerSummary({ data }: { data: ShopifyRecordDetail }) {
  const id = data.id;
  const contacts = data.sections.find((section) => section.key === 'contact')
    ?.rows[0];
  const customer = data.sections.find((section) => section.key === 'customer')
    ?.rows[0];

  return (
    <div className="customer-overview">
      <Card>
        <CardHeader>
          <div>
            <CardTitle as="h2">
              {String(contacts?.fields.Name ?? 'Customer')}
            </CardTitle>
            <p className="field-help">{data.shop}</p>
          </div>
          <Badge>Source identity</Badge>
        </CardHeader>
        <CardContent>
          <dl className="customer-facts">
            <div>
              <dt>Email</dt>
              <dd>
                {String(
                  contacts?.fields.Email ??
                    (contacts ? 'Not provided' : 'Access unavailable'),
                )}
              </dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd>
                {String(
                  contacts?.fields.Phone ??
                    (contacts ? 'Not provided' : 'Access unavailable'),
                )}
              </dd>
            </div>
            <div>
              <dt>Source customer ID</dt>
              <dd className="customer-id">{id}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle as="h2">Customer history</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="customer-facts">
            <div>
              <dt>Orders reported by source</dt>
              <dd>{String(customer?.fields.Orders ?? 'Unavailable')}</dd>
            </div>
            <div>
              <dt>Amount spent</dt>
              <dd>{String(customer?.fields.Spent ?? 'Unavailable')}</dd>
            </div>
            <div>
              <dt>Read from source</dt>
              <dd>
                <WorkspaceDate value={data.observedAt} />
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
