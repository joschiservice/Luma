/**
 * Reply drafts and their lifecycle. Drafts restate the current state of linked records with a
 * citation for each statement; evidence that is missing or older than a day is named in the
 * text and never filled in. Templates are deterministic, in German or English.
 */

import type { RecordKind } from './linking.js';
import type { Address } from './threads.js';

/** Evidence older than this is stated as unconfirmed instead of restated. */
export const staleAfterMs = 24 * 3_600_000;

export type ReplyLanguage = 'en' | 'de';

/** A record's current state as an owner reported it, read for the drafting person. */
export type RecordState =
  | {
      kind: 'order';
      label: string;
      observedAt: string;
      status: string;
      paymentStatus: string;
      fulfillment:
        'unfulfilled' | 'partial' | 'fulfilled' | 'not_required' | 'no_lines';
      /** When the order is due to ship; null when the source reports none. */
      dueAt: string | null;
      tracking: { carrier: string | null; number: string }[];
    }
  | {
      kind: 'purchase_order';
      label: string;
      observedAt: string;
      stage: string;
      expectedDate: string | null;
      lines: {
        description: string;
        unit: string;
        confirmed: number | null;
        outstanding: number;
        expectedDate: string | null;
      }[];
    }
  | {
      kind: 'customer' | 'supplier';
      label: string;
      observedAt: string;
    };

/** A statement in a draft with the record it restates and how current that record was. */
export interface Citation {
  record: { kind: RecordKind; id: string; label: string | null };
  statement: string;
  observedAt: string | null;
  freshness: 'fresh' | 'stale' | 'missing';
}

/** The message a reply answers, as stored. */
export interface ReplyBasis {
  direction: 'inbound' | 'outbound';
  from: Address;
  replyTo: Address[];
  subject: string;
  text: string | null;
  rfcMessageId: string | null;
  references: string[];
  receivedAt: string;
}

const germanWords = new Set([
  'und',
  'ich',
  'sie',
  'nicht',
  'bitte',
  'danke',
  'vielen',
  'dank',
  'wir',
  'ist',
  'der',
  'die',
  'das',
  'mit',
  'für',
  'eine',
  'einen',
  'auf',
  'noch',
  'wann',
  'bestellung',
  'lieferung',
  'hallo',
  'grüße',
  'gruß',
  'sehr',
  'geehrte',
  'geehrter',
  'freundlichen',
  'können',
  'haben',
  'wo',
  'meine',
  'unsere',
]);

const englishWords = new Set([
  'and',
  'the',
  'you',
  'not',
  'please',
  'thanks',
  'thank',
  'we',
  'is',
  'with',
  'for',
  'an',
  'on',
  'still',
  'when',
  'order',
  'delivery',
  'hello',
  'hi',
  'regards',
  'dear',
  'best',
  'can',
  'have',
  'where',
  'my',
  'our',
  'your',
]);

/** German when the text reads clearly German; English otherwise. */
export function detectLanguage(text: string): ReplyLanguage {
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  let german = 0;
  let english = 0;
  for (const word of words.slice(0, 400)) {
    if (germanWords.has(word)) german++;
    if (englishWords.has(word)) english++;
  }
  if (/[äöüß]/i.test(text)) german += 2;

  return german >= 2 && german > english ? 'de' : 'en';
}

/** The subject of a reply: one `Re:` before the subject without earlier reply or forward marks. */
export function replySubject(subject: string) {
  let rest = subject.replace(/[\r\n]+/g, ' ').trim();
  for (;;) {
    const stripped = rest
      .replace(/^(?:re|aw|antw|sv|wg|fw|fwd)(?:\[\d+\])?\s*:\s*/i, '')
      .trim();
    if (stripped === rest) break;
    rest = stripped;
  }

  return `Re: ${rest || '(no subject)'}`.slice(0, 500);
}

const rfcId = /^[\x21-\x3b\x3d\x3f-\x7e]{1,900}$/;

/** Threading headers for a reply to `latest`: its Message-ID and the chain before it. */
export function threadHeaders(latest: ReplyBasis | undefined) {
  const id =
    latest?.rfcMessageId &&
    rfcId.test(latest.rfcMessageId) &&
    latest.rfcMessageId.includes('@')
      ? latest.rfcMessageId
      : null;
  const chain = (latest?.references ?? []).filter(
    (ref) => rfcId.test(ref) && ref.includes('@'),
  );

  return {
    inReplyTo: id,
    references: [...new Set([...chain, ...(id ? [id] : [])])].slice(-20),
  };
}

const lower = (address: Address): Address => ({
  address: address.address.trim().toLowerCase(),
  name: address.name?.replace(/[\r\n]+/g, ' ').trim() || null,
});

/**
 * Recipients of a reply: the reply-to addresses of the latest inbound message, else its sender,
 * without the mailbox itself. Nobody is copied automatically.
 */
export function replyRecipients(
  latestInbound: Pick<ReplyBasis, 'from' | 'replyTo'>,
  mailbox: string | null,
): Address[] {
  const own = mailbox?.toLowerCase() ?? null;
  const candidates = (
    latestInbound.replyTo.length ? latestInbound.replyTo : [latestInbound.from]
  ).map(lower);
  const seen = new Set<string>();

  return candidates.filter((a) => {
    if (a.address === own || seen.has(a.address) || !a.address.includes('@'))
      return false;
    seen.add(a.address);

    return true;
  });
}

const dateOnly = (iso: string) => iso.slice(0, 10);

const quantity = (value: number) =>
  Number(value.toFixed(6)).toLocaleString('en-US', {
    maximumFractionDigits: 6,
    useGrouping: false,
  });

const text = {
  en: {
    greeting: (name: string | null) => (name ? `Hello ${name},` : 'Hello,'),
    thanks: 'Thank you for your message.',
    looking: 'I am looking into this and will get back to you.',
    closing: 'Kind regards',
    record: (kind: RecordKind, label: string | null) =>
      `${kind === 'purchase_order' ? 'purchase order' : 'order'}${label ? ` ${label}` : ''}`,
    missing: (record: string) =>
      `I can't confirm the current status of ${record} right now. I will get back to you once I have checked it.`,
    stale: (record: string) =>
      `The information I have on ${record} is more than a day old, so I can't confirm its current status right now. I will get back to you once I have checked it.`,
    order(state: Extract<RecordState, { kind: 'order' }>) {
      const parts: string[] = [];
      const name = `Order ${state.label}`;
      if (state.status.toLowerCase() === 'cancelled')
        return `${name} is cancelled.`;
      parts.push(
        state.fulfillment === 'unfulfilled'
          ? `${name} has not shipped yet.`
          : state.fulfillment === 'partial'
            ? `${name} has partly shipped.`
            : state.fulfillment === 'fulfilled'
              ? `${name} has shipped.`
              : `${name} is ${state.status}.`,
      );
      if (state.paymentStatus)
        parts.push(`The payment is recorded as ${state.paymentStatus}.`);
      if (state.tracking.length)
        parts.push(
          `Tracking: ${state.tracking
            .map((t) => [t.carrier, t.number].filter(Boolean).join(' '))
            .join(', ')}.`,
        );
      if (state.dueAt && ['unfulfilled', 'partial'].includes(state.fulfillment))
        parts.push(`It is planned to ship by ${dateOnly(state.dueAt)}.`);

      return parts.join(' ');
    },
    stages: {
      draft: 'is not placed yet',
      awaiting_approval: 'is not placed yet',
      sending: 'is being placed',
      send_failed: 'is not placed yet',
      awaiting_confirmation: 'is waiting for your confirmation',
      confirmed: 'is confirmed',
      changed: 'has changes we are reviewing',
      partially_received: 'is partly received',
      received: 'is fully received',
      closed: 'is closed',
      cancelled: 'is cancelled',
    } as Record<string, string>,
    purchaseOrder(state: Extract<RecordState, { kind: 'purchase_order' }>) {
      const parts = [
        `Purchase order ${state.label} ${this.stages[state.stage] ?? `is ${state.stage.replaceAll('_', ' ')}`}.`,
      ];
      for (const line of state.lines
        .filter((l) => l.outstanding > 0)
        .slice(0, 10))
        parts.push(
          `${line.description}: ${quantity(line.outstanding)} ${line.unit} outstanding${
            line.confirmed !== null
              ? `, ${quantity(line.confirmed)} ${line.unit} confirmed`
              : ''
          }${line.expectedDate ? `, expected on ${line.expectedDate}` : ''}.`,
        );

      return parts.join(' ');
    },
  },
  de: {
    greeting: (name: string | null) => (name ? `Hallo ${name},` : 'Guten Tag,'),
    thanks: 'vielen Dank für Ihre Nachricht.',
    looking: 'Ich kümmere mich darum und melde mich bei Ihnen.',
    closing: 'Viele Grüße',
    record: (_kind: RecordKind, label: string | null) =>
      `der Bestellung${label ? ` ${label}` : ''}`,
    missing: (record: string) =>
      `Den aktuellen Stand ${record} kann ich gerade nicht bestätigen. Ich melde mich, sobald ich ihn geprüft habe.`,
    stale: (record: string) =>
      `Meine Informationen zum Stand ${record} sind älter als einen Tag, daher kann ich den aktuellen Stand gerade nicht bestätigen. Ich melde mich, sobald ich ihn geprüft habe.`,
    order(state: Extract<RecordState, { kind: 'order' }>) {
      const parts: string[] = [];
      const name = `Die Bestellung ${state.label}`;
      if (state.status.toLowerCase() === 'cancelled')
        return `${name} wurde storniert.`;
      parts.push(
        state.fulfillment === 'unfulfilled'
          ? `${name} ist noch nicht versandt.`
          : state.fulfillment === 'partial'
            ? `${name} ist teilweise versandt.`
            : state.fulfillment === 'fulfilled'
              ? `${name} ist versandt.`
              : `${name} hat den Status ${state.status}.`,
      );
      if (state.paymentStatus)
        parts.push(`Der Zahlungsstatus ist ${state.paymentStatus}.`);
      if (state.tracking.length)
        parts.push(
          `Sendungsverfolgung: ${state.tracking
            .map((t) => [t.carrier, t.number].filter(Boolean).join(' '))
            .join(', ')}.`,
        );
      if (state.dueAt && ['unfulfilled', 'partial'].includes(state.fulfillment))
        parts.push(`Der Versand ist bis ${dateOnly(state.dueAt)} geplant.`);

      return parts.join(' ');
    },
    stages: {
      draft: 'ist noch nicht aufgegeben',
      awaiting_approval: 'ist noch nicht aufgegeben',
      sending: 'wird gerade aufgegeben',
      send_failed: 'ist noch nicht aufgegeben',
      awaiting_confirmation: 'wartet auf Ihre Bestätigung',
      confirmed: 'ist bestätigt',
      changed: 'hat Änderungen, die wir prüfen',
      partially_received: 'ist teilweise eingegangen',
      received: 'ist vollständig eingegangen',
      closed: 'ist abgeschlossen',
      cancelled: 'ist storniert',
    } as Record<string, string>,
    purchaseOrder(state: Extract<RecordState, { kind: 'purchase_order' }>) {
      const parts = [
        `Die Bestellung ${state.label} ${this.stages[state.stage] ?? `hat den Status ${state.stage}`}.`,
      ];
      for (const line of state.lines
        .filter((l) => l.outstanding > 0)
        .slice(0, 10))
        parts.push(
          `${line.description}: ${quantity(line.outstanding)} ${line.unit} offen${
            line.confirmed !== null
              ? `, ${quantity(line.confirmed)} ${line.unit} bestätigt`
              : ''
          }${line.expectedDate ? `, erwartet am ${line.expectedDate}` : ''}.`,
        );

      return parts.join(' ');
    },
  },
};

export interface DraftInput {
  /** The latest inbound message; replies answer it. */
  latestInbound: ReplyBasis;
  /** The latest message of the thread in either direction, for threading headers. */
  latest: ReplyBasis;
  mailboxAddress: string | null;
  /** Active links in display order, with what their owner reported; null when unreadable. */
  records: {
    kind: RecordKind;
    id: string;
    label: string | null;
    state: RecordState | null;
  }[];
  now: Date;
}

/**
 * Builds a reply from the thread and the current state of its linked records. Every statement
 * about a record is cited with the record's observation time. Records that could not be read,
 * or were read more than a day ago, are named as unconfirmed and their facts are left out.
 * Internal notes and the inbound text are never quoted; the text only decides the language.
 */
export function composeReply(input: DraftInput) {
  const language = detectLanguage(
    `${input.latestInbound.subject}\n${input.latestInbound.text ?? ''}`,
  );
  const t = text[language];
  const citations: Citation[] = [];
  const paragraphs: string[] = [];
  const recipients = replyRecipients(input.latestInbound, input.mailboxAddress);
  let greetingName = recipients[0]?.name ?? null;

  for (const record of input.records) {
    if (record.kind === 'case') continue;
    const reference = { kind: record.kind, id: record.id, label: record.label };
    const state = record.state;
    const stale =
      !!state &&
      input.now.getTime() - Date.parse(state.observedAt) > staleAfterMs;
    if (record.kind === 'customer' || record.kind === 'supplier') {
      // Names only greet; a missing or old profile is not worth a sentence.
      if (!greetingName && state && !stale) {
        greetingName = state.label;
        citations.push({
          record: reference,
          statement: t.greeting(state.label),
          observedAt: state.observedAt,
          freshness: 'fresh',
        });
      }
      continue;
    }
    const name = t.record(record.kind, state?.label ?? record.label);
    if (!state) {
      const statement = t.missing(name);
      paragraphs.push(statement);
      citations.push({
        record: reference,
        statement,
        observedAt: null,
        freshness: 'missing',
      });
      continue;
    }
    if (stale) {
      const statement = t.stale(name);
      paragraphs.push(statement);
      citations.push({
        record: reference,
        statement,
        observedAt: state.observedAt,
        freshness: 'stale',
      });
      continue;
    }
    const statement =
      state.kind === 'order'
        ? t.order(state)
        : state.kind === 'purchase_order'
          ? t.purchaseOrder(state)
          : '';
    if (!statement) continue;
    paragraphs.push(statement);
    citations.push({
      record: reference,
      statement,
      observedAt: state.observedAt,
      freshness: 'fresh',
    });
  }
  if (!paragraphs.length) paragraphs.push(t.looking);

  return {
    language,
    to: recipients,
    cc: [] as Address[],
    subject: replySubject(input.latestInbound.subject),
    text: [
      t.greeting(greetingName),
      '',
      t.thanks,
      '',
      ...paragraphs.flatMap((p) => [p, '']),
      t.closing,
    ].join('\n'),
    citations,
    ...threadHeaders(input.latest),
  };
}

export type OutboundState =
  | 'draft'
  | 'approval_required'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'sending'
  | 'uncertain'
  | 'sent'
  | 'failed'
  | 'withheld'
  | 'discarded';

/** States in which a reply still needs Luma or a person. */
export const liveStates: readonly OutboundState[] = [
  'approval_required',
  'approved',
  'sending',
  'uncertain',
];

/** What a reply's stored state means to the person reading it. */
export const stateMessages: Record<OutboundState, string> = {
  draft: 'Draft. Check the text and the cited records before sending.',
  approval_required:
    'Waiting for someone else who can approve changes to approve this reply.',
  approved: 'Approved. Luma is sending it as the person who requested it.',
  rejected: 'The reply was rejected. Nothing was sent.',
  expired: 'The approval request expired. Nothing was sent.',
  sending: 'Luma is sending the reply.',
  uncertain:
    'The mailbox did not confirm the send. Luma reads the thread to check and will not send it again.',
  sent: 'Sent. A fresh read of the thread found the message.',
  failed: 'The reply was not sent.',
  withheld: 'The reply was not sent.',
  discarded: 'Discarded. Nothing was sent.',
};

/** The person looking at a reply. `can` answers for core and app permissions. */
export interface ReplyReader {
  id: string;
  can(permission: string): boolean;
}

/**
 * What the reader can do with a reply now. Only its author edits, requests and sends it;
 * approval needs someone else with `decisions.respond` and the mailbox app's send permission.
 */
export function replyActions(
  reply: {
    state: OutboundState;
    requestedBy: string;
    expiresAt: string | null;
    approverId: string | null;
    permission: string | null;
  },
  reader: ReplyReader,
  now: Date,
) {
  const expired =
    reply.state === 'approval_required' &&
    !!reply.expiresAt &&
    Date.parse(reply.expiresAt) <= now.getTime();
  const author = reader.id === reply.requestedBy;
  const sender = reader.can('messages.send');

  return {
    state: expired ? ('expired' as const) : reply.state,
    canEdit: sender && author && reply.state === 'draft',
    canRequest: sender && author && reply.state === 'draft',
    canApprove:
      reply.state === 'approval_required' &&
      !expired &&
      !author &&
      !reply.approverId &&
      reader.can('decisions.respond') &&
      (!reply.permission || reader.can(reply.permission)),
    canSend: sender && author && reply.state === 'approved',
    canCheck:
      sender && (reply.state === 'sending' || reply.state === 'uncertain'),
  };
}
