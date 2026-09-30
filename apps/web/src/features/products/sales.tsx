import type { ProductDetail } from '@luma/api-contract';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';

type Sales = ProductDetail['sales']['sources'][number];

/** Expands sparse daily totals into one entry per UTC day from `since`, zero-filled. */
export function dailySeries(sales: Sales, since: string, days = 30) {
  const totals = new Map(
    sales.daily.map((day) => [day.date, Number(day.quantity)]),
  );
  const start = Date.parse(since);

  return Array.from({ length: days + 1 }, (_, index) => {
    const date = new Date(start + index * 86_400_000)
      .toISOString()
      .slice(0, 10);

    return { date, quantity: totals.get(date) ?? 0 };
  });
}

/**
 * Draws one source's units ordered per day as thin bars on a shared baseline. The bars are
 * decorative; the summary names the totals and a disclosure lists the days with orders.
 */
export function SalesBars({
  sales,
  since,
  label,
}: {
  sales: Sales;
  since: string;
  label: string;
}) {
  const series = dailySeries(sales, since);
  const max = Math.max(...series.map((day) => day.quantity), 0);
  const summary = `${sales.quantity} ${sales.unit} in ${sales.orders} ${sales.orders === 1 ? 'order' : 'orders'}`;

  return (
    <figure className="products-sales">
      <figcaption>
        <strong>{label}</strong>
        <span>{summary}</span>
      </figcaption>
      <div
        className="products-sales-bars"
        role="img"
        aria-label={`${label}: ${summary} in the last 30 days, peaking at ${max} ${sales.unit} on one day.`}
      >
        {series.map((day) => (
          <span
            key={day.date}
            className="products-sales-bar"
            data-empty={day.quantity === 0 || undefined}
            style={{
              height: `${day.quantity && max ? Math.max(8, (day.quantity / max) * 100) : 0}%`,
            }}
            title={`${day.date}: ${day.quantity} ${sales.unit}`}
          />
        ))}
      </div>
      <div className="products-sales-axis" aria-hidden="true">
        <span>{series[0]?.date.slice(5)}</span>
        <span>Today</span>
      </div>
      <Disclosure variant="plain" className="products-sales-days">
        <summary>Daily units</summary>
        <table>
          <caption className="sr-only">{`${label} units ordered by day`}</caption>
          <thead>
            <tr>
              <th scope="col">Day (UTC)</th>
              <th scope="col">Units</th>
            </tr>
          </thead>
          <tbody>
            {series
              .filter((day) => day.quantity)
              .map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>{day.quantity}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Disclosure>
    </figure>
  );
}
