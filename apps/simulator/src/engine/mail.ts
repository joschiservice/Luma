import { customer, germanSpeaking } from '@luma/simulator-commerce';
import { keyedRandom } from '@luma/simulator-core';
import { csv, type DeliverAttachment, textPdf } from '@luma/simulator-gmail';
import {
  type JtlCommand,
  kinds,
  type PurchaseOrderRecord,
  type SupplierRecord,
} from '@luma/simulator-jtl';

import type { WorldOrder } from './orders.js';
import { erpContext, mail, type World } from './world.js';

const day = 86_400_000;

type ConfirmCommand = Extract<JtlCommand, { kind: 'purchase-order-confirm' }>;

/**
 * Whether the merchant and a supplier correspond in German: both must be German-speaking;
 * otherwise they write English.
 */
const german = (world: World, supplier: SupplierRecord) =>
  world.model.profile.company.language === 'de' &&
  germanSpeaking(supplier.countryIso);

/** The operations mailbox's labels for supplier and customer mail. */
export const mailboxLabels = (language: 'de' | 'en') =>
  language === 'de'
    ? { suppliers: 'Lieferanten', customers: 'Kunden' }
    : { suppliers: 'Suppliers', customers: 'Customers' };

const labels = (world: World) =>
  mailboxLabels(world.model.profile.company.language);

/** The domain of the merchant's mailbox, which also signs its own Message-IDs. */
const merchantDomain = (world: World) => {
  const address = world.model.mailbox.config.address;

  return address.slice(address.indexOf('@') + 1);
};

const addDays = (date: string, count: number) =>
  new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + count * day)
    .toISOString()
    .slice(0, 10);

const dateText = (date: string, de: boolean) => {
  const [year, month, dayOfMonth] = date.slice(0, 10).split('-');

  return de ? `${dayOfMonth}.${month}.${year}` : date.slice(0, 10);
};

/** The RFC Message-ID of the ERP's email for a purchase order, so supplier answers can reply. */
const orderMessageId = (world: World, order: PurchaseOrderRecord) =>
  `po.${order.orderNumber.toLowerCase()}@${merchantDomain(world)}`;

async function purchaseOrder(world: World, id: string) {
  const store = erpContext(world).store;
  const order = (await store.get<PurchaseOrderRecord>(kinds.purchaseOrder, id))
    ?.data;
  const supplier = order
    ? (await store.get<SupplierRecord>(kinds.supplier, order.supplierId))?.data
    : undefined;

  return order && supplier ? { order, supplier } : undefined;
}

const signature = (supplier: SupplierRecord, de: boolean) =>
  de
    ? `Mit freundlichen Grüßen\n${supplier.companyName}\nVertriebsinnendienst`
    : `Kind regards\n${supplier.companyName}\nCustomer service`;

/**
 * Records the purchase-order email the ERP sends from the operations mailbox, with the order
 * as a PDF, at `at` (now by default). Delivering it again for the same order changes nothing.
 */
export async function purchaseOrderMail(
  world: World,
  id: string,
  at = world.now,
) {
  const found = await purchaseOrder(world, id);
  if (!found) return;
  const { order, supplier } = found;
  const de = german(world, supplier);
  const lines = order.lineItems.map(
    (line) => `${line.quantity} x ${line.itemNumber} ${line.name}`,
  );
  const date = dateText(order.requestedDeliveryDate, de);
  const company = world.model.profile.company;
  // The ERP's own document follows the merchant's language, whoever receives it.
  const merchantGerman = company.language === 'de';
  await mail(world, {
    kind: 'deliver',
    from: world.model.mailbox.config,
    to: [{ address: supplier.email, name: supplier.companyName }],
    subject: de
      ? `Bestellung ${order.orderNumber}`
      : `Purchase order ${order.orderNumber}`,
    text: [
      de ? 'Guten Tag,' : 'Hello,',
      '',
      de
        ? `anbei unsere Bestellung ${order.orderNumber} mit Wunschliefertermin ${date}:`
        : `please find our purchase order ${order.orderNumber}, requested delivery ${date}:`,
      '',
      ...lines,
      '',
      de
        ? 'Bitte bestätigen Sie Mengen und Liefertermin.'
        : 'Please confirm quantities and delivery date.',
      '',
      de ? 'Mit freundlichen Grüßen' : 'Kind regards',
      `${company.name}, ${merchantGerman ? 'Einkauf' : 'Purchasing'}, ${company.city}`,
    ].join('\n'),
    messageId: orderMessageId(world, order),
    attachments: [
      {
        filename: `${merchantGerman ? 'Bestellung' : 'PO'}-${order.orderNumber}.pdf`,
        mimeType: 'application/pdf',
        base64: textPdf(
          merchantGerman
            ? [
                `${company.name} · ${company.city}`,
                `Bestellung ${order.orderNumber}`,
                `Lieferant: ${supplier.companyName} (${supplier.supplierNumber})`,
                `Liefertermin: ${dateText(order.requestedDeliveryDate, true)}`,
                '',
                ...lines,
              ]
            : [
                `${company.name} · ${company.city}`,
                `Purchase order ${order.orderNumber}`,
                `Supplier: ${supplier.companyName} (${supplier.supplierNumber})`,
                `Delivery date: ${dateText(order.requestedDeliveryDate, false)}`,
                '',
                ...lines,
              ],
        ),
      },
    ],
    at,
  });
}

/** One line of a supplier's answer: what it confirms now and what follows later. */
interface AnswerLine {
  sku: string;
  name: string;
  ordered: number;
  now: number;
  nowDate: string;
  rest: number;
  restDate: string | null;
}

function splitText(
  order: PurchaseOrderRecord,
  supplier: SupplierRecord,
  lines: AnswerLine[],
  de: boolean,
) {
  return [
    de ? 'Guten Tag,' : 'Hello,',
    '',
    de
      ? `vielen Dank für Ihre Bestellung ${order.orderNumber}. Leider können wir nicht alles auf einmal liefern:`
      : `thank you for your order ${order.orderNumber}. We cannot ship everything at once:`,
    '',
    ...lines.map((line) =>
      line.rest
        ? de
          ? `${line.sku} ${line.name}: Wir können ${line.now} Stück am ${dateText(line.nowDate, true)} senden; die restlichen ${line.rest} folgen in der Woche darauf (${dateText(line.restDate!, true)}).`
          : `${line.sku} ${line.name}: We can send ${line.now} units on ${line.nowDate}; the remaining ${line.rest} will follow next week (${line.restDate}).`
        : de
          ? `${line.sku} ${line.name}: ${line.now} Stück am ${dateText(line.nowDate, true)}.`
          : `${line.sku} ${line.name}: ${line.now} units on ${line.nowDate}.`,
    ),
    '',
    de
      ? 'Den Lieferplan finden Sie im Anhang.'
      : 'The delivery schedule is attached.',
    '',
    signature(supplier, de),
  ].join('\n');
}

const schedule = (
  order: PurchaseOrderRecord,
  lines: AnswerLine[],
  de: boolean,
) =>
  csv([
    de
      ? [
          'Bestellung',
          'Artikelnummer',
          'Bezeichnung',
          'Bestellt',
          'Menge',
          'Liefertermin',
        ]
      : [
          'Purchase order',
          'SKU',
          'Description',
          'Ordered',
          'Quantity',
          'Delivery date',
        ],
    ...lines.flatMap((line) => [
      [
        order.orderNumber,
        line.sku,
        line.name,
        line.ordered,
        line.now,
        line.nowDate,
      ],
      ...(line.rest && line.restDate
        ? [
            [
              order.orderNumber,
              line.sku,
              line.name,
              line.ordered,
              line.rest,
              line.restDate,
            ],
          ]
        : []),
    ]),
  ]);

/** Delivers a supplier's email answering a purchase order, as a reply to the ERP's email. */
async function answer(
  world: World,
  order: PurchaseOrderRecord,
  supplier: SupplierRecord,
  input: {
    text: string;
    attachments: DeliverAttachment[];
    messageId: string;
  },
) {
  const de = german(world, supplier);
  const prefix = de ? 'AW' : 'RE';
  const base = de
    ? `Bestellung ${order.orderNumber}`
    : `Purchase order ${order.orderNumber}`;

  return mail(world, {
    kind: 'deliver',
    from: { address: supplier.email, name: supplier.companyName },
    // The subject keeps the ERP's wording, so Gmail threads the answer with the order email.
    subject: `${prefix}: ${base}`,
    text: input.text,
    inReplyTo: orderMessageId(world, order),
    messageId: input.messageId,
    labels: [labels(world).suppliers],
    attachments: input.attachments,
    at: world.now,
  });
}

/**
 * Emails the supplier's answer after it confirms a purchase order: a confirmation with a PDF,
 * a split delivery with a CSV schedule when it confirms less than ordered, or a delay notice
 * when it confirms a later date.
 */
export async function supplierConfirmationMail(
  world: World,
  command: ConfirmCommand,
) {
  const found = await purchaseOrder(world, command.orderId);
  if (!found || !command.lines?.length) return;
  const { order, supplier } = found;
  const de = german(world, supplier);
  const lines: AnswerLine[] = command.lines.flatMap((confirmed) => {
    const line = order.lineItems.find(
      (item) => item.lineItemId === confirmed.lineItemId,
    );
    if (!line) return [];
    const rest = Math.max(0, line.quantity - confirmed.quantity);

    return [
      {
        sku: line.itemNumber,
        name: line.name,
        ordered: line.quantity,
        now: confirmed.quantity,
        nowDate: confirmed.deliveryDate,
        rest,
        restDate: rest ? addDays(confirmed.deliveryDate, 7) : null,
      },
    ];
  });
  const requested = new Map(
    order.lineItems.map((line) => [line.itemNumber, line.deliveryDate]),
  );
  const tag = order.orderNumber.toLowerCase();
  const domain = supplier.email.slice(supplier.email.indexOf('@') + 1);
  if (lines.some((line) => line.rest > 0))
    return answer(world, order, supplier, {
      text: splitText(order, supplier, lines, de),
      attachments: [
        {
          filename: `${de ? 'Lieferplan' : 'Delivery-schedule'}-${order.orderNumber}.csv`,
          mimeType: 'text/csv',
          base64: schedule(order, lines, de),
        },
      ],
      messageId: `split.${tag}@${domain}`,
    });
  const late = lines.find(
    (line) =>
      line.nowDate.slice(0, 10) > (requested.get(line.sku) ?? '').slice(0, 10),
  );
  if (late) {
    const reason = keyedRandom(
      world.run.seed,
      'mail-delay',
      order.orderNumber,
    ).pick(
      de
        ? [
            'Unser Vorlieferant hat das Material verspätet geliefert.',
            'Wegen eines Maschinenausfalls verschiebt sich die Produktion.',
          ]
        : [
            'Our own supplier delivered the material late.',
            'A machine breakdown delays production.',
          ],
    );

    return answer(world, order, supplier, {
      text: [
        de ? 'Guten Tag,' : 'Hello,',
        '',
        de
          ? `leider können wir Ihre Bestellung ${order.orderNumber} nicht zum Wunschtermin liefern. ${reason}`
          : `unfortunately we cannot deliver your order ${order.orderNumber} on the requested date. ${reason}`,
        de
          ? `Neuer Liefertermin für alle Positionen: ${dateText(late.nowDate, true)}.`
          : `New delivery date for all items: ${late.nowDate}.`,
        '',
        de
          ? 'Wir bitten um Entschuldigung.'
          : 'We apologise for the inconvenience.',
        '',
        signature(supplier, de),
      ].join('\n'),
      attachments: [],
      messageId: `delay.${tag}@${domain}`,
    });
  }

  return answer(world, order, supplier, {
    text: [
      de ? 'Guten Tag,' : 'Hello,',
      '',
      de
        ? `wir bestätigen Ihre Bestellung ${order.orderNumber} wie bestellt. Die Auftragsbestätigung finden Sie im Anhang.`
        : `we confirm your order ${order.orderNumber} as ordered. The order confirmation is attached.`,
      '',
      signature(supplier, de),
    ].join('\n'),
    attachments: [
      {
        filename: `AB-${order.orderNumber}.pdf`,
        mimeType: 'application/pdf',
        base64: textPdf([
          supplier.companyName,
          de ? 'Auftragsbestätigung' : 'Order confirmation',
          `${de ? 'Ihre Bestellung' : 'Your order'}: ${order.orderNumber}`,
          '',
          ...lines.map(
            (line) =>
              `${line.now} x ${line.sku} ${line.name} · ${dateText(line.nowDate, de)}`,
          ),
        ]),
      },
    ],
    messageId: `ab.${tag}@${domain}`,
  });
}

/**
 * Delivers a supplier's split-delivery email for an open purchase order without changing the
 * ERP: about 60% ships in three days and the rest a week later, with a CSV schedule.
 */
export async function splitDeliveryMail(
  world: World,
  id: string,
  reference: string,
) {
  const found = await purchaseOrder(world, id);
  if (!found) throw new Error('Purchase order not found');
  const { order, supplier } = found;
  const de = german(world, supplier);
  const soon = new Date(world.now + 3 * day).toISOString().slice(0, 10);
  const lines: AnswerLine[] = order.lineItems.map((line) => {
    const now = Math.max(1, Math.floor(line.quantity * 0.6));

    return {
      sku: line.itemNumber,
      name: line.name,
      ordered: line.quantity,
      now,
      nowDate: soon,
      rest: Math.max(0, line.quantity - now),
      restDate: addDays(soon, 7),
    };
  });
  const domain = supplier.email.slice(supplier.email.indexOf('@') + 1);
  const result = await answer(world, order, supplier, {
    text: splitText(order, supplier, lines, de),
    attachments: [
      {
        filename: `${de ? 'Lieferplan' : 'Delivery-schedule'}-${order.orderNumber}.csv`,
        mimeType: 'text/csv',
        base64: schedule(order, lines, de),
      },
    ],
    messageId: `split.${order.orderNumber.toLowerCase()}.${reference}@${domain}`,
  });

  return { order, supplier, lines, result };
}

/**
 * Delivers a customer's email asking where an order is, quoting the order name. The wording
 * depends on the run's seed and the order, so it stays the same for the same run.
 */
export async function customerDelayMail(
  world: World,
  order: WorldOrder,
  reference: string,
) {
  const shopInstance = world.model.shops.find(
    (item) => item.name === order.shop,
  );
  if (!shopInstance || !order.customer) return undefined;
  const person = customer(
    world.run.seed,
    order.shop,
    shopInstance.shop.country,
    order.customer,
  );
  const random = keyedRandom(
    world.run.seed,
    'customer-mail',
    order.shop,
    order.order,
  );
  // Most customers of German-speaking shops write German; the others write English.
  const de = random.chance(0.8) && germanSpeaking(shopInstance.shop.country);
  const subject = random.pick(
    de
      ? [
          `Wo bleibt meine Bestellung ${order.name}?`,
          `Lieferung ${order.name} noch nicht angekommen`,
        ]
      : [
          `Where is my order ${order.name}?`,
          `Order ${order.name} has not arrived`,
        ],
  );
  const text = de
    ? [
        'Hallo,',
        '',
        `ich habe Bestellung ${order.name} aufgegeben, aber sie ist immer noch nicht angekommen. Laut Sendungsverfolgung hängt das Paket fest.`,
        'Können Sie mir sagen, wann die Lieferung kommt?',
        '',
        'Viele Grüße',
        `${person.firstName} ${person.lastName}`,
      ]
    : [
        'Hello,',
        '',
        `I ordered ${order.name} but it still has not arrived, and the tracking has not moved for days.`,
        'Could you tell me when it will be delivered?',
        '',
        'Thanks',
        `${person.firstName} ${person.lastName}`,
      ];

  return mail(world, {
    kind: 'deliver',
    from: {
      address: person.email,
      name: `${person.firstName} ${person.lastName}`,
    },
    subject,
    text: text.join('\n'),
    messageId: `delay.${order.shop}.${order.order}.${reference}@customer.example`,
    labels: [labels(world).customers],
    at: world.now,
  });
}
