const named: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  zwnj: '',
  zwj: '',
  euro: '€',
  pound: '£',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  bull: '•',
  middot: '·',
  times: '×',
  deg: '°',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  aacute: 'á',
  agrave: 'à',
  oacute: 'ó',
  iacute: 'í',
  uacute: 'ú',
  ccedil: 'ç',
  ntilde: 'ñ',
};

/** Decodes HTML character references; unknown names stay as written. */
function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi,
    (match, ref: string) => {
      if (ref.startsWith('#')) {
        const code =
          ref[1] === 'x' || ref[1] === 'X'
            ? parseInt(ref.slice(2), 16)
            : parseInt(ref.slice(1), 10);
        if (
          !Number.isFinite(code) ||
          code === 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        )
          return '\uFFFD';

        return String.fromCodePoint(code);
      }

      return named[ref] ?? match;
    },
  );
}

/** Largest HTML body converted before returning a truncated result. */
const maxHtml = 2_000_000;

/** Converts bounded HTML to text without executing it, retaining input truncation. */
export function convertHtml(html: string): {
  text: string;
  truncated: boolean;
} {
  const input = html.slice(0, maxHtml);
  const chunks: string[] = [];
  let hidden: string | null = null;
  let position = 0;
  while (position < input.length) {
    const opening = input.indexOf('<', position);
    const end = opening < 0 ? input.length : opening;
    if (!hidden) chunks.push(input.slice(position, end));
    if (opening < 0) break;
    if (input.startsWith('<!--', opening)) {
      const close = input.indexOf('-->', opening + 4);
      position = close < 0 ? input.length : close + 3;
      continue;
    }
    const closing = input.indexOf('>', opening + 1);
    // An unfinished tag consumes the remaining input, without repeated suffix searches.
    if (closing < 0) break;
    const tag = /^<(\/?)([a-z][a-z0-9]*)\b/i.exec(
      input.slice(opening, closing + 1),
    );
    position = closing + 1;
    if (!tag) continue;
    const name = tag[2]!.toLowerCase();
    const isClose = !!tag[1];
    if (hidden) {
      if (isClose && name === hidden) hidden = null;
      continue;
    }
    if (
      !isClose &&
      ['script', 'style', 'head', 'title', 'template'].includes(name)
    ) {
      hidden = name;
      continue;
    }
    if (name === 'br') chunks.push('\n');
    else if (name === 'li' && !isClose) chunks.push('\n- ');
    else if (/^(p|h[1-6]|blockquote|pre|table|ul|ol|hr)$/.test(name))
      chunks.push('\n\n');
    else if (/^(div|tr|section|article|header|footer)$/.test(name))
      chunks.push('\n');
    else if (isClose && /^(td|th)$/.test(name)) chunks.push(' ');
  }

  return {
    text: normalizeText(decodeEntities(chunks.join(''))),
    truncated: html.length > maxHtml,
  };
}

/** Converts HTML to readable plain text without rendering or executing markup. */
export function htmlToText(html: string): string {
  return convertHtml(html).text;
}

/** Normalizes line endings, trims trailing spaces and collapses runs of blank lines. */
function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
