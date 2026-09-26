# @luma/app-host

Defines first-party app contracts, validates registration, and manages workspace app installation. Tenant lifecycle commands refresh membership and persist atomic connection revocation with installation events. Optional storage hooks run inside the same transaction.

`/http` exposes authenticated lifecycle routes. `/web` exposes types for deferred React contributions without importing server code.

See [Workspace apps](../../docs/apps.md).
