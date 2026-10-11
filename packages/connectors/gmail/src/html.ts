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

/** Largest HTML body converted; longer bodies are cut first, which also bounds regex work. */
const maxHtml = 2_000_000;

/**
 * Converts an HTML body to readable plain text without rendering it: drops comments, scripts,
 * styles and head content, turns block boundaries and line breaks into newlines, removes every
 * tag and decodes character references. The result is text only and never contains markup to
 * execute.
 */
export function htmlToText(html: string): string {
  const text = html
    .slice(0, maxHtml)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(
      /<(script|style|head|title|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      '',
    )
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/?(?:p|h[1-6]|blockquote|pre|table|ul|ol|hr)\b[^>]*>/gi, '\n\n')
    .replace(/<\/?(?:div|tr|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');

  return normalizeText(decodeEntities(text));
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
