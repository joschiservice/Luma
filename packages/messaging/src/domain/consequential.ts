/**
 * Which replies commit the business. A reply is consequential when it states a date or
 * deadline, a quantity, or money, or when the mailbox requires approval for every reply.
 * Consequential replies need approval from someone else before they are sent; the classifier
 * errs towards approval, so a false positive costs a review, never an unreviewed commitment.
 */

export type ConsequentialReason =
  'date' | 'quantity' | 'money' | 'workspace_policy';

const weekdays =
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag';

const months =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|januar|februar|märz|maerz|mai|juni|juli|oktober|dezember|okt|dez';

const datePatterns: RegExp[] = [
  // 2026-10-12
  /\b\d{4}-\d{1,2}-\d{1,2}\b/,
  // 12.10. and 12.10.2026
  /(?<![\d.])\d{1,2}\.\d{1,2}\.(?:\d{2,4})?(?![\d])/,
  // 12/10 and 10/12/2026
  /(?<![\d/])\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?![\d/])/,
  // 12 October, 12. Oktober, 12th of October
  new RegExp(
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?(?:${months})\\b`,
    'iu',
  ),
  // October 12
  new RegExp(`\\b(?:${months})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'iu'),
  new RegExp(`\\b(?:${weekdays})s?\\b`, 'iu'),
  /\b(?:today|tonight|tomorrow|next|this|end of the|end of|by the end of)\s+(?:week|month|weekend|business day|working day)\b/i,
  /\b(?:today|tomorrow|tonight|asap)\b/i,
  /\b(?:within|in)\s+(?:\d+|a|one|two|three|four|five|a few)\s+(?:business\s+|working\s+)?(?:days?|weeks?|hours?)\b/i,
  // German: heute, morgen (not "Guten Morgen"), übermorgen, nächste Woche, Ende der Woche
  /(?<!guten\s)\b(?:heute|morgen)\b/iu,
  /übermorgen/iu,
  /\b(?:nächste[nrs]?|naechste[nrs]?|kommende[nrs]?|diese[nrs]?)\s+(?:woche|monat|wochenende)\b/iu,
  /\bende\s+(?:der|dieser|nächster|naechster)\s+(?:woche|monat)\b/iu,
  /\b(?:innerhalb\s+von|in)\s+(?:\d+|einem|einer|zwei|drei|vier|fünf|wenigen)\s+(?:werk|arbeits)?(?:tage?n?|wochen?|stunden?)\b/iu,
];

const units =
  'units?|pcs|pc|pieces?|items?|ea|each|cartons?|boxes|box|cases|pallets?|packs?|kg|g|t|l|ml|m|stück|stk|kartons?|kisten?|paletten?|packungen?|einheiten?';

const quantityPatterns: RegExp[] = [
  new RegExp(
    `\\b\\d+(?:[.,]\\d+)?\\s*(?:x\\s*)?(?:${units})(?![\\p{L}])`,
    'iu',
  ),
  // "quantity of 40", "Menge 40"
  /\b(?:quantity|qty|menge|anzahl)\s*(?:of|von|:)?\s*\d+/iu,
  // "40 bottles confirmed", "12 Flaschen offen": a count in a commitment context.
  /(?<![#\w-])\d+(?:[.,]\d+)?\s+(?:[^\s\d]+\s+){0,2}(?:outstanding|confirmed|ordered|reserved|offen|bestätigt|bestellt|reserviert)(?![\p{L}])/iu,
];

const moneyPatterns: RegExp[] = [
  /[€$£]\s?\d/u,
  // Bounded runs keep matching linear on long digit strings; a longer amount still matches
  // from a later digit.
  /\d(?:[\d.,'\s]{0,30}\d)?\s?(?:€|\$|£)/u,
  /\b\d(?:[\d.,']{0,30}\d)?\s?(?:eur|euro|euros|usd|gbp|chf|dollars?|pounds?)\b/iu,
  /\b(?:eur|usd|gbp|chf)\s?\d/iu,
  /\b(?:refund\w*|reimburse\w*|credit(?:s|ed| note)?|discount\w*|compensat\w*|voucher\w*|rebate\w*)\b/iu,
  /(?:gutschrift\w*|erstatt\w*|rückerstatt\w*|rueckerstatt\w*|rabatt\w*|nachlass\w*|gutschein\w*|entschädigung\w*)/iu,
];

const matches = (patterns: readonly RegExp[], text: string) =>
  patterns.some((pattern) => pattern.test(text));

/**
 * Lists why a reply needs approval, in a stable order; empty when it can be sent at once.
 * Reads the subject and text as they would be sent. Statements Luma cited from records count
 * like any other text: a confirmed date is a commitment whoever wrote it.
 */
export function consequentialReasons(input: {
  subject: string;
  text: string;
  approveAll: boolean;
}): ConsequentialReason[] {
  const text = `${input.subject}\n${input.text}`.normalize('NFC');
  const reasons: ConsequentialReason[] = [];
  if (matches(datePatterns, text)) reasons.push('date');
  if (matches(quantityPatterns, text)) reasons.push('quantity');
  if (matches(moneyPatterns, text)) reasons.push('money');
  if (input.approveAll) reasons.push('workspace_policy');

  return reasons;
}
