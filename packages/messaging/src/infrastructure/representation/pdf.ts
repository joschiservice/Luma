import { getDocumentProxy } from 'unpdf';

import { representationLimits } from '../../domain/documents.js';

/** Raised for PDFs Luma cannot read; the reason is a controlled code. */
export class PdfError extends Error {
  constructor(readonly reason: 'encrypted' | 'damaged') {
    super(`PDF ${reason}`);
  }
}

/** pdf.js reports document problems by exception name. */
const damaged = new Set([
  'InvalidPDFException',
  'MissingPDFException',
  'UnexpectedResponseException',
  'FormatError',
]);

/**
 * Reads the text layer of a PDF, one string per page, in reading order with line breaks where
 * the PDF ends lines; fonts are not loaded. Password-protected and damaged files
 * raise `PdfError`; pages and characters beyond the limits are cut and reported.
 */
export async function parsePdf(bytes: Uint8Array): Promise<{
  pages: string[];
  truncated: boolean;
}> {
  let document: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js may transfer the buffer it is given; read from a copy.
    document = await getDocumentProxy(new Uint8Array(bytes), {
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'PasswordException') throw new PdfError('encrypted');
    if (damaged.has(name)) throw new PdfError('damaged');
    throw error;
  }
  try {
    const pages: string[] = [];
    let characters = 0;
    let truncated = document.numPages > representationLimits.pages;
    const count = Math.min(document.numPages, representationLimits.pages);
    for (let number = 1; number <= count; number++) {
      const content = await (await document.getPage(number)).getTextContent();
      let text = '';
      for (const item of content.items)
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      const room = representationLimits.characters - characters;
      if (text.length > room) {
        pages.push(text.slice(0, Math.max(room, 0)));
        truncated = true;
        break;
      }
      characters += text.length;
      pages.push(text);
    }

    return { pages, truncated };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (damaged.has(name)) throw new PdfError('damaged');
    throw error;
  } finally {
    await document.loadingTask.destroy();
  }
}
