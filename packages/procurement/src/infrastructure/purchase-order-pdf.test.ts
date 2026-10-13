import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import type { PurchaseOrder } from '../domain/procurement.js';
import { purchaseOrderPdf } from './purchase-order-pdf.js';

const order: PurchaseOrder = {
  id: 'order',
  tenantId: 'tenant',
  supplierId: 'supplier',
  supplierName: 'Müller GmbH',
  reference: 'PO-1001',
  authority: 'luma',
  externalReferences: [],
  origin: {},
  status: 'draft',
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lines: [
    {
      id: 'line',
      sku: 'SKU-1',
      supplierArticleNumber: 'ART-1',
      description: 'Ökologisches Produkt',
      quantity: 40,
      unit: 'each',
      unitPrice: { amount: '3.50', currency: 'EUR' },
    },
  ],
};
const input = {
  order,
  supplierName: order.supplierName,
  company: {
    name: 'Shop GmbH',
    address: 'Hauptstraße 12\n10115 Berlin',
    registration: 'USt-IdNr. DE123456789',
  },
  language: 'de' as const,
  requestedDeliveryDate: '2026-10-20',
};

describe('purchase-order PDF', () => {
  it('renders an immutable German purchasing snapshot and deterministic retries', async () => {
    const first = await purchaseOrderPdf(input);
    const second = await purchaseOrderPdf(input);
    expect(second).toEqual(first);
    const pdf = await PDFDocument.load(first);
    expect(pdf.getTitle()).toBe('Bestellung PO-1001');
    expect(pdf.getAuthor()).toBe('Shop GmbH');
    expect(pdf.getPageCount()).toBe(1);
  });
  it('paginates long article text and explicitly missing prices without clipping rows', async () => {
    const pdf = await PDFDocument.load(
      await purchaseOrderPdf({
        ...input,
        language: 'en',
        order: {
          ...order,
          lines: Array.from({ length: 45 }, (_, index) => ({
            id: String(index),
            sku: `SKU-${index}`,
            description:
              'A longer article description with a detailed product specification '.repeat(
                2,
              ),
            quantity: 40,
            unit: 'each',
          })),
        },
      }),
    );
    expect(pdf.getPageCount()).toBeGreaterThan(3);
    expect(pdf.getTitle()).toBe('Purchase order PO-1001');
  });
  it('refuses unsupported glyphs rather than silently corrupting the supplier document', async () => {
    await expect(
      purchaseOrderPdf({
        ...input,
        company: { ...input.company, name: '商品' },
      }),
    ).rejects.toThrow();
  });
});
