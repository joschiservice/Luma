# @luma/policies

Evaluates action policy and approval requirements and persists policy decisions.

Evaluation uses current identity and action evidence. Approval semantics live here so every caller applies the same rules. Execution consumes the decision and performs effects; audit recording is injected.

## Public entry points

- `@luma/policies`
- `@luma/policies/composition`

## Further reading

- [Case decisions](../../docs/case-decisions.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
