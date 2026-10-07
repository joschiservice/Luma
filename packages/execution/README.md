# @luma/execution

Admits and executes actions using policy decisions, tenant authorization, durable execution records and audit evidence.

Effects are supplied through a capability registry. Preserve idempotency and uncertain-write reconciliation: a retry or restart must never repeat an external effect. Interpreted playbook steps receive bound, reference-only admission rather than unrestricted execution or provisioning access.

## Public entry points

- `@luma/execution`
- `@luma/execution/composition`

## Further reading

- [Execution](../../docs/execution.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
