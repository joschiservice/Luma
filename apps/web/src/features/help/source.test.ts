import { locales } from '@luma/i18n/runtime';
import { describe, expect, it, vi } from 'vitest';

import german from '../../../content/docs/meta.de.json';
import english from '../../../content/docs/meta.json';
import { helpTopics } from './context';
import { docPage, docSection, docSections, source } from './source';

const guidesIn = (meta: { pages: string[] }) =>
  meta.pages.filter((entry) => !entry.startsWith('---'));

describe('documentation source', () => {
  it('lists every guide in one section, in the same order for each language', () => {
    expect(guidesIn(german)).toEqual(guidesIn(english));
    expect(german.pages.length).toBe(english.pages.length);

    const slugs = source
      .getPages('en')
      .map((page) => page.slugs.join('/'))
      .sort();
    for (const locale of locales) {
      const listed = docSections(locale).flatMap((section) =>
        section.guides.map((guide) => guide.slug),
      );
      expect([...listed].sort()).toEqual(slugs);
    }
  });

  it('keeps canonical URLs for every language', () => {
    const english = docPage('issues/resolve', 'en');
    const german = docPage('issues/resolve', 'de');
    expect(english?.page.url).toBe('/docs/issues/resolve');
    expect(german?.page.url).toBe('/docs/issues/resolve');
    expect(english?.translated).toBe(true);
    expect(german?.translated).toBe(true);
    expect(german?.page.path).not.toBe(english?.page.path);
    expect(docPage('unknown-guide', 'de')).toBeUndefined();
  });

  it('marks the English guide as untranslated when a language has no translation', () => {
    const getPage = source.getPage.bind(source);
    // Fumadocs answers a missing translation with the English page.
    const spy = vi
      .spyOn(source, 'getPage')
      .mockImplementation((slugs) => getPage(slugs, 'en'));
    try {
      const german = docPage('issues/resolve', 'de');
      expect(german?.page.url).toBe('/docs/issues/resolve');
      expect(german?.translated).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('names sections in the reader’s language', () => {
    expect(docSection('issues/resolve', 'en')).toBe('Daily work');
    expect(docSection('issues/resolve', 'de')).toBe('Tägliche Arbeit');
    expect(
      docSections('en').find((section) => section.title === 'Daily work')
        ?.guides,
    ).toContainEqual(
      expect.objectContaining({ slug: 'issues/resolve', nested: true }),
    );
  });

  it('opens an existing guide for every help topic', () => {
    for (const topic of helpTopics)
      expect(docPage(topic, 'en'), topic).toBeDefined();
  });
});
