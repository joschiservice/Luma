import { z } from 'zod';

/** A lower-case DNS domain with at least two labels. */
const domain = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );

/**
 * A lower-case address whose local part uses only characters that carry no meaning in Gmail
 * search, so it can be placed in a query without quoting.
 */
const address = z
  .string()
  .max(320)
  .refine((value) => {
    const at = value.lastIndexOf('@');

    return (
      at > 0 &&
      /^[a-z0-9._%+-]{1,64}$/.test(value.slice(0, at)) &&
      domain.safeParse(value.slice(at + 1)).success
    );
  });

/** A label name Gmail search can quote: no quotes, backslashes or control characters. */
const labelName = z
  .string()
  .min(1)
  .max(225)
  .regex(/^[^"\\\p{Cc}]+$/u);

export const mailboxFilter = z
  .object({
    senderDomains: z.array(domain).max(200),
    senderAddresses: z.array(address).max(200),
    recipientAddresses: z.array(address).max(50),
    labels: z.array(labelName).max(50),
    includeSent: z.boolean(),
  })
  .strict();

export type MailboxFilter = z.infer<typeof mailboxFilter>;

const group = (operator: string, values: string[]) =>
  `${operator}:(${values.join(' OR ')})`;

/**
 * Builds the Gmail search query for a mailbox filter and receipt window, or null when the
 * filter is empty and must match nothing.
 *
 * Gmail matches `from:example.com` against address tokens, so a domain term also matches its
 * subdomains (and can match lookalikes such as `example.com.other.example`). Callers re-check
 * every returned message with {@link matchesFilter} and drop those that do not match exactly.
 */
export function buildQuery(
  filter: MailboxFilter,
  receivedSince: string,
): string | null {
  const value = mailboxFilter.parse(filter);
  const since = Date.parse(receivedSince);
  if (!Number.isFinite(since)) throw new Error('Invalid receivedSince');
  const senders = [
    ...new Set([...value.senderDomains, ...value.senderAddresses]),
  ];
  const recipients = [...new Set(value.recipientAddresses)];
  const labels = [...new Set(value.labels)];
  const terms: string[] = [];
  if (senders.length) terms.push(group('from', senders));
  if (recipients.length)
    terms.push(
      group('to', recipients),
      group('cc', recipients),
      group('deliveredto', recipients),
    );
  for (const label of labels) terms.push(`label:"${label}"`);
  if (value.includeSent && senders.length)
    terms.push(
      `(in:sent ${group('to', senders)})`,
      `(in:sent ${group('cc', senders)})`,
    );
  if (!terms.length) return null;

  // Gmail's after: takes epoch seconds and is exclusive, so start one second earlier.
  return `(${terms.join(' OR ')}) after:${Math.max(0, Math.floor(since / 1000) - 1)}`;
}

/** The parts of a message a filter is evaluated against. */
export interface FilterSubject {
  from: string;
  to: string[];
  cc: string[];
  deliveredTo: string[];
  labels: string[];
  outbound: boolean;
}

const domainOf = (value: string) => value.slice(value.lastIndexOf('@') + 1);

const inDomains = (value: string, domains: string[]) => {
  const host = domainOf(value);

  return domains.some((d) => host === d || host.endsWith(`.${d}`));
};

/**
 * Checks a fetched message against the filter exactly: sender domain (including subdomains)
 * or address, recipient address in To, Cc or Delivered-To, label name, or, when `includeSent`,
 * a sent message addressed to a listed sender.
 */
export function matchesFilter(
  filter: MailboxFilter,
  subject: FilterSubject,
): boolean {
  const party = (value: string) =>
    filter.senderAddresses.includes(value) ||
    inDomains(value, filter.senderDomains);
  const recipients = [...subject.to, ...subject.cc];

  return (
    party(subject.from) ||
    [...recipients, ...subject.deliveredTo].some((value) =>
      filter.recipientAddresses.includes(value),
    ) ||
    // Gmail label names are case-insensitive.
    subject.labels.some((label) =>
      filter.labels.some((l) => l.toLowerCase() === label.toLowerCase()),
    ) ||
    (filter.includeSent && subject.outbound && recipients.some(party))
  );
}
