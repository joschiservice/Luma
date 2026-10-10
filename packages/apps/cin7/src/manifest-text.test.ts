import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { createApp } from './index.js';

// The web localizes manifest text by key from the English catalogs; both must say the same thing.
const messages = (namespace: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../i18n/messages/en/${namespace}.json`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, string>;

const key = (id: string) => id.replaceAll(/[.:-]/g, '_');

it('keeps the English message catalogs in sync with the manifest', () => {
  const { manifest } = createApp();
  const permissions = messages('permissions');

  expect(
    messages('catalog')[`catalog_app_${key(manifest.id)}_description`],
  ).toBe(manifest.description);
  for (const permission of manifest.permissions) {
    expect(permissions[`permissions_${key(permission.key)}_label`]).toBe(
      permission.label,
    );
    expect(permissions[`permissions_${key(permission.key)}_description`]).toBe(
      permission.description,
    );
  }
});
