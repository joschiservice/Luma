import type { MailAddress, MessageRecord } from './model.js';

/** A search Gmail cannot parse; the API answers 400. */
export class QueryError extends Error {}

type Node =
  | { kind: 'and' | 'or'; nodes: Node[] }
  | { kind: 'not'; node: Node }
  | { kind: 'term'; field: string | null; value: string };

const operators = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'deliveredto',
  'subject',
  'label',
  'in',
  'is',
  'has',
  'filename',
  'after',
  'before',
  'older',
  'newer',
  'newer_than',
  'older_than',
  'rfc822msgid',
]);

type Token =
  | { kind: '(' | ')' | '{' | '}' | '-' }
  | { kind: 'word'; value: string; quoted: boolean };

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < query.length) {
    const char = query[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if ('(){}'.includes(char)) {
      tokens.push({ kind: char as '(' });
      index++;
      continue;
    }
    // A leading minus negates the term it precedes.
    if (char === '-' && /[^\s)]/.test(query[index + 1] ?? ' ')) {
      tokens.push({ kind: '-' });
      index++;
      continue;
    }
    if (char === '"') {
      const end = query.indexOf('"', index + 1);
      if (end < 0) throw new QueryError('Unterminated quote');
      tokens.push({
        kind: 'word',
        value: query.slice(index + 1, end),
        quoted: true,
      });
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < query.length && !/[\s(){}"]/.test(query[end]!)) end++;
    // `label:"a b"` keeps the quoted value with its operator.
    if (query[end] === '"' && query[end - 1] === ':') {
      const close = query.indexOf('"', end + 1);
      if (close < 0) throw new QueryError('Unterminated quote');
      tokens.push({
        kind: 'word',
        value: `${query.slice(index, end)}${query.slice(end + 1, close)}`,
        quoted: true,
      });
      index = close + 1;
      continue;
    }
    tokens.push({
      kind: 'word',
      value: query.slice(index, end),
      quoted: false,
    });
    index = end;
  }

  return tokens;
}

function split(word: string) {
  const colon = word.indexOf(':');
  if (colon <= 0) return null;
  const field = word.slice(0, colon).toLowerCase();

  return operators.has(field) ? { field, value: word.slice(colon + 1) } : null;
}

/** Parses Gmail's search syntax: operators, implicit AND, `OR`, `-`, `( )` and `{ }`. */
function parseQuery(query: string): Node {
  const tokens = tokenize(query);
  let position = 0;
  const peek = () => tokens[position];
  const isOr = (token: Token | undefined) =>
    token?.kind === 'word' && !token.quoted && token.value === 'OR';

  function or(field: string | null): Node {
    const nodes = [and(field)];
    while (isOr(peek())) {
      position++;
      nodes.push(and(field));
    }

    return nodes.length === 1 ? nodes[0]! : { kind: 'or', nodes };
  }

  function and(field: string | null): Node {
    const nodes: Node[] = [];
    for (;;) {
      const token = peek();
      if (!token || isOr(token) || token.kind === ')' || token.kind === '}')
        break;
      nodes.push(unary(field));
    }
    if (!nodes.length) throw new QueryError('Empty search group');

    return nodes.length === 1 ? nodes[0]! : { kind: 'and', nodes };
  }

  function unary(field: string | null): Node {
    const token = peek();
    if (token?.kind === '-') {
      position++;

      return { kind: 'not', node: unary(field) };
    }

    return primary(field);
  }

  function group(field: string | null, open: '(' | '{'): Node {
    position++;
    let node: Node;
    if (open === '(') node = or(field);
    else {
      const nodes: Node[] = [];
      while (peek() && peek()!.kind !== '}') nodes.push(unary(field));
      if (!nodes.length) throw new QueryError('Empty search group');
      node = { kind: 'or', nodes };
    }
    if (peek()?.kind !== (open === '(' ? ')' : '}'))
      throw new QueryError('Unbalanced parentheses');
    position++;

    return node;
  }

  function primary(field: string | null): Node {
    const token = peek();
    if (!token) throw new QueryError('Incomplete search');
    if (token.kind === '(' || token.kind === '{')
      return group(field, token.kind);
    if (token.kind !== 'word') throw new QueryError('Unexpected token');
    position++;
    const operator = token.quoted && field ? null : split(token.value);
    if (operator && operator.value === '') {
      const next = peek();
      if (next?.kind === '(' || next?.kind === '{')
        return group(operator.field, next.kind);
      throw new QueryError(`Missing value for ${operator.field}`);
    }
    if (operator && token.quoted)
      return { kind: 'term', field: operator.field, value: operator.value };
    if (operator) return { kind: 'term', ...operator };

    return { kind: 'term', field, value: token.value };
  }

  if (!tokens.length) return { kind: 'and', nodes: [] };
  const node = or(null);
  if (position < tokens.length) throw new QueryError('Unbalanced parentheses');

  return node;
}

const lower = (value: string) => value.trim().toLowerCase();

function addressMatches(addresses: MailAddress[], raw: string) {
  const value = lower(raw);
  if (value.startsWith('@')) {
    const domain = value.slice(1);

    return addresses.some((item) => {
      const at = item.address.slice(item.address.lastIndexOf('@') + 1);

      return at === domain || at.endsWith(`.${domain}`);
    });
  }
  if (value.includes('@'))
    return addresses.some((item) => item.address === value);

  return addresses.some(
    (item) =>
      item.address.includes(value) ||
      (item.name ?? '').toLowerCase().includes(value),
  );
}

const normalizeLabel = (value: string) => lower(value).replace(/[\s/-]+/g, '-');

/** Reads `after:` and `before:` dates: epoch seconds or `yyyy/mm/dd` (UTC midnight here). */
function dateValue(raw: string) {
  if (/^\d{1,12}$/.test(raw)) return Number(raw) * 1000;
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(raw);
  if (!match) throw new QueryError(`Invalid date ${raw}`);

  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function relative(raw: string) {
  const match = /^(\d{1,6})([dmy])$/i.exec(raw);
  if (!match) throw new QueryError(`Invalid period ${raw}`);
  const days = { d: 1, m: 30, y: 365 }[match[2]!.toLowerCase() as 'd'];

  return Number(match[1]) * days * 86_400_000;
}

/** Searchable view of a message with resolved label names. */
export interface SearchableMessage {
  message: MessageRecord;
  /** Lower-cased label IDs and user label names. */
  labels: Set<string>;
}

function matches(node: Node, item: SearchableMessage, now: number): boolean {
  if (node.kind === 'not') return !matches(node.node, item, now);
  if (node.kind !== 'term')
    return node.kind === 'and'
      ? node.nodes.every((child) => matches(child, item, now))
      : node.nodes.some((child) => matches(child, item, now));
  const { message } = item;
  const value = node.value;
  const recipients = [...message.to, ...message.cc, ...message.bcc];
  switch (node.field) {
    case 'from':
      return addressMatches([message.from], value);
    case 'to':
    case 'deliveredto':
      return addressMatches(recipients, value);
    case 'cc':
      return addressMatches(message.cc, value);
    case 'bcc':
      return addressMatches(message.bcc, value);
    case 'subject':
      return message.subject.toLowerCase().includes(lower(value));
    case 'label':
      return item.labels.has(normalizeLabel(value));
    case 'in':
      return lower(value) === 'anywhere' || item.labels.has(lower(value));
    case 'is':
      return item.labels.has(lower(value));
    case 'has':
      return lower(value) === 'attachment'
        ? message.attachments.length > 0
        : item.labels.has(lower(value));
    case 'filename':
      return message.attachments.some((attachment) =>
        attachment.filename.toLowerCase().includes(lower(value)),
      );
    case 'after':
    case 'newer':
      // Epoch seconds are exclusive; a calendar date includes that day.
      return /^\d+$/.test(value)
        ? message.internalDate > dateValue(value)
        : message.internalDate >= dateValue(value);
    case 'before':
    case 'older':
      return message.internalDate < dateValue(value);
    case 'newer_than':
      return message.internalDate >= now - relative(value);
    case 'older_than':
      return message.internalDate < now - relative(value);
    case 'rfc822msgid':
      return (
        message.messageId.toLowerCase() === lower(value).replace(/^<|>$/g, '')
      );
    default: {
      const needle = lower(value);

      return [
        message.subject,
        message.text,
        message.from.address,
        message.from.name ?? '',
        ...recipients.map((recipient) => recipient.address),
        ...message.attachments.map((attachment) => attachment.filename),
      ].some((text) => text.toLowerCase().includes(needle));
    }
  }
}

function fields(node: Node): { field: string | null; value: string }[] {
  if (node.kind === 'term') return [node];
  if (node.kind === 'not') return fields(node.node);

  return node.nodes.flatMap(fields);
}

/** The earliest internal date a match can have, when the query bounds it. */
function lowerBound(node: Node): number | undefined {
  if (node.kind === 'term')
    return node.field === 'after' || node.field === 'newer'
      ? dateValue(node.value)
      : undefined;
  if (node.kind === 'not') return undefined;
  const bounds = node.nodes.map(lowerBound);
  if (node.kind === 'and')
    return bounds.reduce<number | undefined>(
      (max, bound) =>
        bound === undefined ? max : Math.max(max ?? bound, bound),
      undefined,
    );

  return bounds.every((bound) => bound !== undefined)
    ? Math.min(...(bounds as number[]))
    : undefined;
}

/**
 * Compiles a search. Like Gmail, results exclude spam and trash unless the query names them or
 * `in:anywhere`. Throws `QueryError` for malformed queries and invalid dates.
 */
export function compileQuery(query: string) {
  const node = parseQuery(query);
  // Validates dates eagerly so a malformed query fails before any match.
  const bound = lowerBound(node);
  for (const term of fields(node))
    if (term.field === 'before' || term.field === 'older')
      dateValue(term.value);
    else if (term.field === 'newer_than' || term.field === 'older_than')
      relative(term.value);
  const hidden = !fields(node).some(
    (term) =>
      (term.field === 'in' || term.field === 'label') &&
      ['anywhere', 'spam', 'trash'].includes(lower(term.value)),
  );

  const conjuncts = node.kind === 'and' ? node.nodes : [node];
  const exact = conjuncts.find(
    (term) => term.kind === 'term' && term.field === 'rfc822msgid',
  );

  return {
    /** Lower bound on internal dates, for narrowing the scan. */
    after: bound,
    /** Lower-cased Message-ID every match must have, when the query requires one. */
    messageId:
      exact?.kind === 'term'
        ? lower(exact.value).replace(/^<|>$/g, '')
        : undefined,
    matches(item: SearchableMessage, now: number, includeSpamTrash = false) {
      if (
        hidden &&
        !includeSpamTrash &&
        (item.labels.has('spam') || item.labels.has('trash'))
      )
        return false;

      return matches(node, item, now);
    },
  };
}

/** Label IDs and normalized user label names that `label:`, `in:` and `is:` match. */
export function searchLabels(
  message: MessageRecord,
  names: Map<string, string>,
) {
  const labels = new Set<string>();
  for (const id of message.labelIds) {
    labels.add(id.toLowerCase());
    const name = names.get(id);
    if (name) labels.add(normalizeLabel(name));
  }
  if (!message.labelIds.includes('UNREAD')) labels.add('read');

  return labels;
}
