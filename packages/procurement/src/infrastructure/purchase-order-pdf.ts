import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

import type { PurchasingCompany } from '../application/supplier-email.js';
import type { PurchaseOrder } from '../domain/procurement.js';

/** Creates a paginated English or German order PDF from immutable purchasing line snapshots. */
export async function purchaseOrderPdf(input: {
  order: PurchaseOrder;
  supplierName: string;
  company: PurchasingCompany;
  language: 'en' | 'de';
  requestedDeliveryDate: string;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date(input.order.createdAt));
  pdf.setModificationDate(new Date(input.order.createdAt));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const de = input.language === 'de';
  const t = de
    ? {
        title: 'Bestellung',
        supplier: 'Lieferant',
        delivery: 'Gewünschte Lieferung',
        article: 'Artikel',
        quantity: 'Menge',
        price: 'Einzelpreis',
        missing: 'Nicht angegeben',
        confirmation:
          'Bitte bestätigen Sie Mengen, Preise und Liefertermin. Diese Bestellung ist keine Lieferantenbestätigung.',
      }
    : {
        title: 'Purchase order',
        supplier: 'Supplier',
        delivery: 'Requested delivery',
        article: 'Article',
        quantity: 'Quantity',
        price: 'Unit price',
        missing: 'Not provided',
        confirmation:
          'Please confirm quantities, prices and the delivery date. This order is not a supplier confirmation.',
      };
  pdf.setTitle(`${t.title} ${input.order.reference}`);
  pdf.setAuthor(input.company.name);
  let page = pdf.addPage([595.28, 841.89]);
  let y = 790;
  const margin = 44;
  const width = 507;
  const lineHeight = 15;
  const wrapped = (value: string, maxWidth: number, size = 10, face = font) => {
    const lines: string[] = [];
    for (const paragraph of value.split(/\r?\n/)) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (face.widthOfTextAtSize(candidate, size) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        line = '';
        // Long article numbers also wrap; no field can run beyond the page margin.
        for (const char of word) {
          if (face.widthOfTextAtSize(line + char, size) > maxWidth) {
            lines.push(line);
            line = '';
          }
          line += char;
        }
      }
      lines.push(line);
    }

    return lines;
  };
  const ensure = (height: number) => {
    if (y - height >= 62) return;
    page = pdf.addPage([595.28, 841.89]);
    y = 790;
    page.drawText(`${t.title} ${input.order.reference}`, {
      x: margin,
      y,
      font: bold,
      size: 12,
    });
    y -= 26;
  };
  const text = (value: string, size = 10, strong = false) => {
    for (const line of wrapped(value, width, size, strong ? bold : font)) {
      ensure(lineHeight);
      page.drawText(line, {
        x: margin,
        y,
        size,
        font: strong ? bold : font,
        color: rgb(0.12, 0.16, 0.2),
      });
      y -= size + 5;
    }
  };
  text(input.company.name, 16, true);
  text(input.company.address);
  if (input.company.registration) text(input.company.registration);
  y -= 20;
  text(`${t.title} ${input.order.reference}`, 22, true);
  text(`${t.supplier}: ${input.supplierName}`);
  text(
    `${t.delivery}: ${new Intl.DateTimeFormat(de ? 'de-DE' : 'en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${input.requestedDeliveryDate}T12:00:00Z`))}`,
  );
  y -= 20;
  for (const line of input.order.lines) {
    const article = line.supplierArticleNumber ?? t.missing;
    let price = t.missing;
    if (line.unitPrice) {
      // Supplier prices are decimal strings. Preserve their exact precision in the approved document.
      const [whole, fraction] = line.unitPrice.amount.split('.');
      const integer = new Intl.NumberFormat(de ? 'de-DE' : 'en-GB').format(
        BigInt(whole!),
      );
      price = `${integer}${fraction ? `${de ? ',' : '.'}${fraction}` : ''} ${line.unitPrice.currency}`;
    }
    const rows = [
      line.description,
      `${line.sku} | ${t.article}: ${article}`,
      `${t.quantity}: ${new Intl.NumberFormat(de ? 'de-DE' : 'en-GB', { maximumFractionDigits: 6 }).format(line.quantity)} ${de && line.unit === 'each' ? 'Stück' : line.unit} | ${t.price}: ${price}`,
    ];
    const height =
      rows.flatMap((value, index) =>
        wrapped(value, width, 10, index === 0 ? bold : font),
      ).length *
        lineHeight +
      18;
    ensure(Math.min(height, 660));
    for (const [index, value] of rows.entries()) text(value, 10, index === 0);
    page.drawLine({
      start: { x: margin, y: y - 2 },
      end: { x: margin + width, y: y - 2 },
      thickness: 0.5,
      color: rgb(0.8, 0.83, 0.86),
    });
    y -= 18;
  }
  y -= 12;
  text(t.confirmation);
  const pages = pdf.getPages();
  for (const [index, p] of pages.entries())
    p.drawText(`${index + 1} / ${pages.length}`, {
      x: margin,
      y: 32,
      size: 9,
      font,
      color: rgb(0.4, 0.45, 0.5),
    });

  return pdf.save();
}
