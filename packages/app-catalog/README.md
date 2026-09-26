# @luma/app-catalog

Composes app packages into the host and injects their provider contributions into connection services. Core services remain independent of app implementations.

Run `pnpm apps:sync` after adding or removing a directory in `packages/apps`. The generated deployment catalog contains only packages present in the checkout. `createAppHost` also accepts an explicit factory list, including an empty list.

See [Workspace apps](../../docs/apps.md).
