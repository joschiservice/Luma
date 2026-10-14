import { m } from '@luma/i18n/messages';

/** Names a data region in the current interface language. */
export function regionLabel(region: string) {
  return region === 'AU'
    ? m.identity_region_au()
    : region === 'EU'
      ? m.identity_region_eu()
      : region === 'US'
        ? m.identity_region_us()
        : m.common_not_reported();
}
