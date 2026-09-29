import { Button } from '@luma/ui/components/primitives/button';

import type {
  ShopifyRecordDetail,
  ShopifyRecordRow,
} from '../domain/records.js';

function value(field: ShopifyRecordRow['fields'][string]) {
  if (field === null) return 'Not provided';
  if (typeof field === 'boolean') return field ? 'Yes' : 'No';

  return String(field);
}

/**
 * Renders the sections of one Shopify read, including coverage messages for missing scopes or
 * approval. Link buttons appear only when `follow` is supplied.
 */
export function ShopifyRecordSections({
  detail,
  pending = false,
  follow,
  headingLevel = 3,
}: {
  detail: ShopifyRecordDetail;
  pending?: boolean;
  follow?: ((link: ShopifyRecordRow['links'][number]) => void) | undefined;
  headingLevel?: 3 | 4;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h4';

  return detail.sections.map((section) => (
    <section
      key={section.key}
      className="shopify-record-section"
      aria-label={section.title}
    >
      <Heading>{section.title}</Heading>
      {section.message ? (
        <p className="shopify-coverage-message" role="status">
          {section.message}
        </p>
      ) : null}
      {section.status === 'available' && section.rows.length === 0 ? (
        <p className="field-help">No records returned by Shopify.</p>
      ) : null}
      {section.rows.map((row) => (
        <article key={row.id} className="shopify-source-record">
          <p className="shopify-source-id">{row.id}</p>
          <dl>
            {Object.entries(row.fields).map(([label, field]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value(field)}</dd>
              </div>
            ))}
          </dl>
          {row.sourceUpdatedAt ? (
            <p className="field-help">
              Updated in Shopify{' '}
              {new Date(row.sourceUpdatedAt).toLocaleString()}
            </p>
          ) : null}
          {follow ? (
            <div className="shopify-record-links">
              {row.links
                .filter((link) => link.id !== detail.id)
                .map((link) => (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    key={`${link.kind}:${link.id}`}
                    onClick={() => follow(link)}
                    disabled={pending}
                  >
                    {link.label}
                  </Button>
                ))}
            </div>
          ) : null}
        </article>
      ))}
    </section>
  ));
}
