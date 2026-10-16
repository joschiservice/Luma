import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { htmlToText } from './html.js';

describe('bounded HTML conversion', () => {
  it.each(['script', 'style', 'head', 'title', 'template'])(
    'drops unterminated %s content',
    (tag) => {
      expect(htmlToText(`Visible<${tag}>hidden<${tag}>still hidden`)).toBe(
        'Visible',
      );
    },
  );

  it('bounds malformed parsing in a separate process with a hard deadline', () => {
    const path = new URL('./html.ts', import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { htmlToText } from ${JSON.stringify(path)};
      for (const size of [8_000, 32_000, 128_000, 512_000, 1_900_000]) {
        htmlToText('<' + ' '.repeat(size) + '>');
        for (const tag of ['<script>', '<style>', '<head>', '<!--', '<']) {
          htmlToText(tag.repeat(Math.floor(size / tag.length)));
        }
      }
      process.stdout.write('completed');
    `,
      ],
      { timeout: 2_500, encoding: 'utf8' },
    );
    expect(output).toBe('completed');
  });
});
