import type { ProductDetail } from '@luma/api-contract';
import { formatCalendarDate, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { quantityUnit } from '@luma/ui/lib/units';

import { formatSourceNumber } from '../orders/presentation';

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
  const summary = m.products_sales_summary({
    quantity: formatSourceNumber(sales.quantity),
    unit: quantityUnit(sales.unit, sales.quantity),
    orders: sales.orders,
  });
  const shortDay = (date: string) =>
    formatCalendarDate(date, { day: 'numeric', month: 'short' });

  return (
    <figure className="products-sales">
      <figcaption>
        <strong>{label}</strong>
        <span>{summary}</span>
      </figcaption>
      <div
        className="products-sales-bars"
        role="img"
        aria-label={m.products_sales_chart_label({
          source: label,
          summary,
          peak: formatNumber(max),
          unit: quantityUnit(sales.unit, max),
        })}
      >
        {series.map((day) => (
          <span
            key={day.date}
            className="products-sales-bar"
            data-empty={day.quantity === 0 || undefined}
            style={{
              height: `${day.quantity && max ? Math.max(8, (day.quantity / max) * 100) : 0}%`,
            }}
            title={m.products_sales_day({
              date: formatCalendarDate(day.date),
              quantity: formatNumber(day.quantity),
              unit: quantityUnit(sales.unit, day.quantity),
            })}
          />
        ))}
      </div>
      <div className="products-sales-axis" aria-hidden="true">
        <span>{series[0] ? shortDay(series[0].date) : null}</span>
        <span>{m.products_sales_today()}</span>
      </div>
      <Disclosure variant="plain" className="products-sales-days">
        <summary>{m.products_sales_daily()}</summary>
        <table>
          <caption className="sr-only">
            {m.products_sales_daily_caption({ source: label })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{m.products_sales_day_column()}</th>
              <th scope="col">{m.products_sales_units_column()}</th>
            </tr>
          </thead>
          <tbody>
            {series
              .filter((day) => day.quantity)
              .map((day) => (
                <tr key={day.date}>
                  <td>{formatCalendarDate(day.date)}</td>
                  <td>{formatNumber(day.quantity)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Disclosure>
    </figure>
  );
}
