import type { Represent } from '../../application/document-ports.js';
import { hasContent, representationLimits } from '../../domain/documents.js';
import { parseCsv } from './csv.js';
import { parsePdf, PdfError } from './pdf.js';
import { decodeText, looksBinary, normalizeLines } from './text.js';
import { parseXlsx, WorkbookError } from './xlsx.js';

/** The sheet name of a CSV file: its file name without the extension. */
const csvSheetName = (filename: string) =>
  filename.replace(/\.[a-z0-9]{1,8}$/i, '').slice(0, 200) || 'Sheet1';

/**
 * Builds a representation for each supported format. Damaged, encrypted and empty files end
 * as unreadable with a controlled reason; unexpected parser errors propagate.
 */
export const represent: Represent = async (bytes, { format, filename }) => {
  try {
    if (format === 'pdf') {
      const { pages, truncated } = await parsePdf(bytes);
      const representation = { kind: 'text' as const, pages };

      return hasContent(representation)
        ? { ok: true, representation, truncated }
        : { ok: false, outcome: { state: 'unreadable', failure: 'no_text' } };
    }
    if (format === 'xlsx') {
      const { sheets, truncated } = parseXlsx(bytes);
      const representation = { kind: 'sheets' as const, sheets };

      return hasContent(representation)
        ? { ok: true, representation, truncated }
        : { ok: false, outcome: { state: 'unreadable', failure: 'empty' } };
    }
    const text = decodeText(bytes);
    if (looksBinary(text))
      return {
        ok: false,
        outcome: { state: 'unreadable', failure: 'damaged' },
      };
    if (format === 'csv') {
      const { rows, truncated } = parseCsv(text);
      const representation = {
        kind: 'sheets' as const,
        sheets: [{ name: csvSheetName(filename), rows }],
      };

      return hasContent(representation)
        ? { ok: true, representation, truncated }
        : { ok: false, outcome: { state: 'unreadable', failure: 'empty' } };
    }
    const normalized = normalizeLines(text);
    const representation = {
      kind: 'text' as const,
      pages: [normalized.slice(0, representationLimits.characters)],
    };

    return hasContent(representation)
      ? {
          ok: true,
          representation,
          truncated: normalized.length > representationLimits.characters,
        }
      : { ok: false, outcome: { state: 'unreadable', failure: 'empty' } };
  } catch (error) {
    if (error instanceof PdfError || error instanceof WorkbookError)
      return {
        ok: false,
        outcome:
          error.reason === 'too_large'
            ? { state: 'unsupported', failure: 'too_large' }
            : { state: 'unreadable', failure: error.reason },
      };
    throw error;
  }
};
