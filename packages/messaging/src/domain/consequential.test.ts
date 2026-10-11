import { describe, expect, it } from 'vitest';

import { consequentialReasons } from './consequential.js';

const reasons = (text: string, approveAll = false) =>
  consequentialReasons({ subject: 'Re: Your order', text, approveAll });

describe('consequential replies', () => {
  it.each([
    'We will ship on 2026-10-12.',
    'Lieferung am 12.10.',
    'Lieferung am 12.10.2026.',
    'It leaves our warehouse on 12/10.',
    'Expected 12 October.',
    'Expected October 12th.',
    'We ship on Tuesday.',
    'You will have it by Friday.',
    'Wir versenden am Dienstag.',
    'It goes out next week.',
    'Das kommt nächste Woche.',
    'Ihre Ware kommt morgen.',
    'We will deliver within 3 business days.',
    'Wir liefern innerhalb von 5 Werktagen.',
    'Expect it by the end of the week.',
    'It ships tomorrow.',
  ])('flags the date commitment in "%s"', (text) => {
    expect(reasons(text)).toContain('date');
  });

  it.each([
    'We can send 40 units.',
    'Wir liefern 12 Stück.',
    '20 pcs are on the way.',
    'We reserved 3 pallets.',
    'Bitte 5 Kartons zurückschicken.',
    'Quantity: 15',
    '40 bottles confirmed.',
    'Noch 12 Flaschen offen.',
  ])('flags the quantity in "%s"', (text) => {
    expect(reasons(text)).toContain('quantity');
  });

  it.each([
    'We refund your order.',
    'The total is €49.90.',
    'That costs 49,90 EUR.',
    'We will issue a credit note.',
    'You get a 10% discount.',
    'Wir erstatten Ihnen den Betrag.',
    'Sie erhalten eine Gutschrift.',
    'Wir gewähren 5% Rabatt.',
    'USD 20 have been sent.',
  ])('flags the money in "%s"', (text) => {
    expect(reasons(text)).toContain('money');
  });

  it.each([
    'Thank you for your message. I am looking into this and will get back to you.',
    'Vielen Dank für Ihre Nachricht. Ich kümmere mich darum.',
    'Guten Morgen, wir prüfen das.',
    'Order #1001 has shipped. Tracking: DHL 00340434.',
    'Purchase order PO-1001 is confirmed.',
    'Please send us the invoice as a PDF.',
  ])('lets "%s" go out without approval', (text) => {
    expect(reasons(text)).toEqual([]);
  });

  it('adds the mailbox rule and keeps a stable order', () => {
    expect(reasons('We refund 2 units on Monday.', true)).toEqual([
      'date',
      'quantity',
      'money',
      'workspace_policy',
    ]);
    expect(reasons('Thanks!', true)).toEqual(['workspace_policy']);
  });

  it('reads the subject too', () => {
    expect(
      consequentialReasons({
        subject: 'Refund for order 1001',
        text: 'See below.',
        approveAll: false,
      }),
    ).toEqual(['money']);
  });
});
