# @luma/identity

Owns authentication, organizations, memberships, workspace roles and permissions, tenant context and authorization guards.

The composition entry creates the identity service and owns its database pool; callers must close it. HTTP registration is separate. Keep identity credentials and database privileges separate from workflow persistence.

## Public entry points

- `@luma/identity`
- `@luma/identity/composition`
- `@luma/identity/http`

## Further reading

- [Identity](../../docs/identity.md)
- [Permissions](../../docs/permissions.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
