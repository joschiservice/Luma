# @luma/app-jtl

First-party JTL workspace app. Owns provider settings, permission verification, normalized adapters, configuration, and deferred setup UI.

The public `createApp` factory contributes to the app host. Low-level provider protocols remain in `@luma/connector-jtl`. Use public exports for adapter fixtures.

See [Workspace apps](../../../docs/apps.md) for installation lifecycle, UI slots, migration ownership, and removing an app.
