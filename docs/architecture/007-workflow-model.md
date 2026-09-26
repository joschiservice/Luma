# ADR-007: First-class Workflow ownership

Status: accepted. LUMA-66.

Workflow definitions, versions, activations, runs and their persistence belong to
`@luma/workflows`. Resolution consumes this public contract and owns diagnosis and
case orchestration. Workflows do not import Resolution or Exceptions. Subject and
trigger contracts do not require an Exception; Resolution adds its own references.
Temporal schedules existing application operations and retains durable replay.
Execution remains the only owner of consequential action admission and dispatch.

Existing Resolution versions are adapted without rewriting their content or
hashes. Native versions use a discriminated format in the existing immutable
catalog tables. Unsupported execution is explicit and unavailable. This keeps
reviewable definitions separate from authority to run them.

Resolution may consume Workflow domain contracts. Its former composition and HTTP
entry points may forward to the equivalent Workflow entry points for compatibility.
This narrow exception does not allow application code to construct infrastructure.
Shadow persistence receives compiler/hash adapters through composition.

The model records human or delegated-agent provenance. Authenticated identity and
verified delegation remain required; no actor field grants authority. The same
admission boundaries apply to future agent or communication adapters. LUMA-51's
sandbox, LUMA-67's triggers and LUMA-68's runtime are separate implementation steps.

See [Workflow contracts and compatibility](../workflows.md) for serialization,
publication, API migration and validation details. This updates ADR-001 and
ADR-005's former grouping of playbooks under Resolution.
