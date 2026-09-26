# Workflow model

`@luma/workflows` owns definitions, immutable versions, activation scopes, runs and
step provenance. `@luma/resolution` owns diagnosis, case orchestration and the
shipping-method definition. `@luma/execution` owns action admission and effects.
`@luma/workflow-temporal` remains the durable Resolution adapter. The application
runtime composes these owners; it does not own their business rules.

## Contracts

A Workflow definition has a stable identity, name, intent and category. A version
binds its trigger and subject kind, typed inputs and observed context, stable step
IDs, approval and risk requirements, verification evaluator, escalation outcome
and authorship. Changing any native contract content changes its digest.

A run binds the exact version and activation to a subject, initiating actor and
immutable context snapshot. Exception and diagnosis references live in the
optional Resolution specialization. A manual or event-triggered definition can
be published without an Exception. Publication alone does not start it or grant
execution authority.

`WorkflowActor` represents users and delegated agents. Agent provenance includes
the agent ID, accountable operator and delegation grant. These fields describe
provenance, not permission. The current identity adapter authenticates users;
caller-supplied actor fields are rejected by activation commands. An agent adapter
must resolve its grant through identity, refresh authorization for every start or
continuation, and enter the same activation, policy, approval, action-admission,
reservation, verification and audit path. An actor object must never substitute
for an authenticated tenant context. General agent authentication is not introduced
by the model extraction.

Run history separates dispatch from verification. Step records retain proposal,
decision and outcome references. An accepted provider write or completed runtime
activity does not establish verified business success.

## Authoring and runtime support

Import `defineWorkflow`, `compileWorkflow`, `printWorkflowCode` and
`parseWorkflowCode` from `@luma/workflows/composition`. Authoring accepts typed
structured data. The generated TypeScript view is a JSON literal passed to
`defineWorkflow`; parsing never evaluates imports or expressions.

The initial vocabulary retains eligibility, one capability action, approval,
verification and read-only recovery/escalation. Compilation validates references,
unique step IDs, scalar types and matching policy/outcome contracts. New native
versions use `format: 'workflow/1'`; `ApplicationServices.workflows.publish` stores
them under refreshed administrator authorization. Publication is a trusted
composition operation, not a browser endpoint.

Existing Resolution definitions execute through their existing interpreter. Native
versions are reviewable but unavailable for activation until an execution adapter
supports them. The catalog reports that reason and rejects activation. Native
manual/event trigger metadata does not install a trigger handler. LUMA-67 and
LUMA-68 own general triggers and multi-step execution. Future communication steps
must extend this same versioned vocabulary and admission path. Unsupported step
kinds, including TypeScript Code Steps, fail compilation. LUMA-51 remains gated.

## Compatibility and storage

There is one catalog owner and no data-copy migration:

- Existing `playbook_*` tables, RLS, privileges and immutable composite references
  stay in place. Their SQL names are storage compatibility details.
- Existing serialized Resolution versions and SHA-256 digests are unchanged. The
  common contract marks their digest format as `resolution-playbook/0`; the digest
  covers the original definition, compatibility, provenance and IR, not its API
  projection. Publication/replay of legacy source remains compatible.
- Native definitions/versions use the same definition/version tables with their
  format discriminator. Their digest covers the native authored contract. A
  conflicting definition or version is rejected; native definitions cannot reuse
  a legacy ID with different immutable content.
- Legacy activation/run/outcome documents remain Resolution adapter records. The
  Workflow API projects subject, trigger, actor and context/step provenance without
  changing them. Future generic execution must add its persistence through the
  same Workflow owner rather than weakening legacy evidence constraints.
- Resolution's former public type/composition/HTTP exports forward to the owner.
  New consumers should import `@luma/workflows`. Architecture checks enforce that
  Workflows cannot depend on Resolution or Exceptions.

The new API is `/v1/organizations/:organizationId/workflows` with detail, runs,
activation and revocation endpoints. The legacy `/playbooks` endpoints retain
Resolution responses and the same management controls. Native definitions appear
only in the Workflow API. Both paths share activation records and transaction
locks, so switching API paths cannot bypass overlap or replay checks.

The UI uses `/app/:organizationId/workflows`. Old library and detail URLs redirect
with filters and section anchors preserved. It reuses workspace navigation,
collection controls, version selection and activation dialogs. Trigger, subject,
inputs, approval and verified outcome are shown before technical evidence.

## Validation

Workflow compiler tests cover digest compatibility, native non-Exception
contracts, code-view round trips and rejection of executable steps. Architecture
tests enforce the owner dependency direction. Backend E2E exercises both API
paths, immutable native publication, unavailable runtime handling, actor payload
rejection and cross-tenant access. Browser tests cover filtering, review,
activation, uncertain-response retry, reload, revocation, old bookmarks, mobile
navigation and member access. Existing execution and Resolution tests retain
policy, approval, evidence freshness, restart and uncertain-write coverage.
