import { describe, expect, it } from 'vitest';

import { samples } from '../previews/_shared/samples.js';
import { renderEmail } from './render.js';

const kinds = Object.keys(samples) as (keyof typeof samples)[];

describe('renderEmail', () => {
  it.each(
    kinds.flatMap((kind) => [[kind, 'en'] as const, [kind, 'de'] as const]),
  )('renders %s in %s with HTML and text parts', async (kind, locale) => {
    const email = samples[kind];
    const rendered = await renderEmail(email, locale);

    expect(rendered.subject).not.toBe('');
    expect(rendered.html).toContain(`lang="${locale}"`);
    for (const link of Object.entries(email)
      .filter(([key]) => /link$/i.test(key))
      .map(([, value]) => value as string)) {
      expect(rendered.html).toContain(link.replaceAll('&', '&amp;'));
      // The text part shows addresses without brackets, so they can be copied.
      expect(rendered.text).toContain(link);
      expect(rendered.text).not.toContain(`[${link}`);
    }
  });

  it('uses the recipient’s language, time zone and role names', async () => {
    const en = await renderEmail(samples.invitation, 'en');
    const de = await renderEmail(samples.invitation, 'de');

    expect(en.subject).toBe('Join Nordlicht Outdoor on Luma');
    expect(en.text).toContain('Expires      19 Oct 2026, 11:30 CEST');
    expect(de.subject).toBe('Tritt Nordlicht Outdoor in Luma bei');
    expect(de.text).toContain('mit der Rolle Admin');
    expect(de.text).toContain('19.10.2026, 11:30 MESZ');
  });

  it('shows text from people as text, never as markup', async () => {
    const rendered = await renderEmail(
      {
        ...samples.support_access_requested,
        reason: '<a href="https://evil.example">Click</a> & approve',
      },
      'en',
    );

    expect(rendered.html).not.toContain('href="https://evil.example"');
    expect(rendered.html).toContain('&lt;a href=');
    expect(rendered.text).toContain(
      '<a href="https://evil.example">Click</a> & approve',
    );
  });

  it('keeps the plain-text part free of the preview text and button fallback', async () => {
    const rendered = await renderEmail(samples.password_reset, 'de');

    expect(rendered.text.startsWith('Setze dein Passwort zurück')).toBe(true);
    expect(rendered.text).toContain('15 Minuten');
    expect(rendered.text).not.toContain('Falls der Button');
  });
});
