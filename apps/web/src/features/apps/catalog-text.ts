import type { AppManifest } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

import {
  permissionDescription,
  permissionLabel,
} from '../identity/permission-text';

/*
 * App manifest text localized by app ID: `catalog_app_<id>_description`, with `-` replaced by
 * `_`. App permissions use the permission messages. Tests in each app package fail when the
 * English messages and the manifest differ. App names are product names and stay as declared;
 * unknown apps keep their manifest text.
 */
const descriptions: Record<string, () => string> = {
  shopify: m.catalog_app_shopify_description,
  jtl: m.catalog_app_jtl_description,
  cin7: m.catalog_app_cin7_description,
  gmail: m.catalog_app_gmail_description,
};

/** Returns an app manifest with known descriptions and permissions in the interface language. */
export function localizeManifest(manifest: AppManifest): AppManifest {
  return {
    ...manifest,
    description: Object.hasOwn(descriptions, manifest.id)
      ? descriptions[manifest.id]!()
      : manifest.description,
    permissions: manifest.permissions.map((permission) => ({
      ...permission,
      label: permissionLabel(permission.key, permission.label),
      description: permissionDescription(
        permission.key,
        permission.description,
      ),
    })),
  };
}
