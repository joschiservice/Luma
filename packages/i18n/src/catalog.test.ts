import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const settings = JSON.parse(
  readFileSync(new URL('project.inlang/settings.json', root), 'utf8'),
) as {
  baseLocale: string;
  locales: string[];
  'plugin.inlang.icu-messageformat-1': { pathPattern: string[] };
};
const patterns = settings['plugin.inlang.icu-messageformat-1'].pathPattern;

function catalog(locale: string, file: string) {
  return JSON.parse(
    readFileSync(new URL(`messages/${locale}/${file}`, root), 'utf8'),
  ) as Record<string, string>;
}

/** Collects every ICU argument name, including those nested in plural and select branches. */
function argumentsOf(message: string) {
  return new Set(
    [...message.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)].map(
      (match) => match[1],
    ),
  );
}

const files = readdirSync(new URL(`messages/${settings.baseLocale}/`, root))
  .filter((file) => file.endsWith('.json'))
  .sort();

describe('message catalog', () => {
  it('registers every message file in the inlang project', () => {
    expect([...patterns].sort()).toEqual(
      files.map((file) => `./messages/{locale}/${file}`),
    );
  });

  it.each(files)('keeps %s consistent across languages', (file) => {
    const namespace = basename(file, '.json').replaceAll('-', '_');
    const base = catalog(settings.baseLocale, file);

    for (const [key, message] of Object.entries(base)) {
      expect(key, key).toMatch(
        new RegExp(`^${namespace}_[a-z0-9]+(?:_[a-z0-9]+)*$`),
      );
      expect(message.trim(), key).not.toBe('');
    }
    for (const locale of settings.locales) {
      const messages = catalog(locale, file);
      expect(Object.keys(messages).sort(), `${locale}/${file}`).toEqual(
        Object.keys(base).sort(),
      );
      for (const [key, message] of Object.entries(messages)) {
        expect(argumentsOf(message), `${locale} ${key}`).toEqual(
          argumentsOf(base[key]!),
        );
        if (/,\s*(?:plural|selectordinal)\s*,/.test(message)) {
          // Paraglide inserts `#` without number formatting and compares `=n` to strings.
          expect(message, `${locale} ${key}`).not.toMatch(/#|=\d/);
        }
      }
    }
  });
});
