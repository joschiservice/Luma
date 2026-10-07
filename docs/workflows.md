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

Every authoring mode — templates, the visual builder, the code view and natural
language — edits the same `workflow/2` draft and publishes through one path:
compile → publish an immutable version → activate with explicit grants →
Action Admission → independent verification → audit. Authoring modes are views
of a draft, not separate engines or permission paths.

`defineWorkflow`, `compileWorkflow`, `printWorkflowCode` and `parseWorkflowCode`
remain available from `@luma/workflows/composition` for `workflow/1` composition.
`workflow/2` versions compile with `compileProcessWorkflow`; `checkProcessWorkflow`
returns every problem instead of the first one. Existing Resolution definitions
execute through their existing interpreter. A published version that no installed
adapter can execute is shown as unavailable with the specific reason, and cannot
be activated. Native manual/event trigger metadata does not install a trigger
handler.

### Drafts and publication

Drafts (`workflow_drafts`, migration `0034`) are mutable, tenant-isolated
authoring records. They store the authored content, the authoring mode, the
author, a revision and, when the code view made the last edit, its verbatim text.
Drafts never run and grant nothing.

- **API:** `/v1/organizations/:organizationId/workflow-drafts` (list, create,
  read, save, publish, discard) and `/workflow-authoring/validate`. Owners and
  admins write; members read drafts and validate content.
- **Saves** send the revision the editor loaded. A stale revision returns 409 and
  nothing is overwritten. Reuse the save ID and body after an uncertain response.
  Creates are idempotent by draft ID and body.
- **Saved content** only needs a readable `workflow/2` shape, so incomplete steps
  autosave. Code Steps in a draft omit their runtime binding and artifact digest;
  publication binds them to the pinned runtime.
- **Validation** has no side effects. Diagnostics carry the step index, step ID,
  field path, a plain-language message and a technical detail. Errors block
  publication; warnings say what cannot run in this workspace yet. Validation also
  returns each step's available values (its scope), a readable summary and the
  canonical code view text.
- **Publication** re-authorizes an owner or admin, validates the exact saved
  revision and stores it in the existing immutable catalog in the same transaction
  as the draft update and audit entry. Provenance is `native` with
  `authoring: { mode, draftId, revision, notes }`. A new version must be higher
  than the latest published one, and the same version with different content is
  rejected. Published definitions keep their name, description and category.
  Retrying the same revision returns the same version. Publication never activates
  a version or grants execution authority.
- **Editing a published workflow** starts a new draft from that version with the
  next minor version. Built-in definitions (replenishment and shipping-method
  correction), Resolution and `workflow/1` definitions cannot be edited as drafts;
  customize a template instead. The IDs `new` and `drafts` are reserved for pages.
- **Audit:** `workflow.draft_created`, `workflow.published` and
  `workflow.draft_discarded` entries are written in the same transaction.

### Authoring vocabulary

`GET /workflow-authoring/vocabulary` lists trigger kinds, step kinds, subject
kinds, read sources, capabilities (version, parameters, expected result, risk
floor and approval behaviour), result checks and Code Step support. Installed
domain adapters contribute the entries (`VocabularySource`): the Code Step runtime
contributes computation steps, Procurement its replenishment reads, action and
check, and Resolution the shipping-method action and check. Entries that no
adapter can run in custom workflows here stay listed with the reason.

Drafts may use only known entries: unknown subjects, reads, capabilities or checks
are errors, as are risk levels below the capability's floor and values of the wrong
type. Known entries that cannot run here are warnings. The catalog uses the same
check to explain why a published custom version is unavailable.

### Templates

`GET /workflow-templates` lists published definitions offered by domain adapters
(`TemplateSource`) with what they do, what success means, their requirements,
readiness and activation status. Templates are not a separate store:
`POST /workflow-templates/:templateId/install` publishes the template's reviewed
version in the workspace (safe to repeat, never activates). **Use template** then
configures and activates through the existing path — replenishment rules,
Resolution activation or a [case workflow](#case-workflows) activation — so the
same server authorization and overlap checks apply.
**Customize** creates a draft copy with a new ID; the published template never
changes. The Resolution shipping-method correction is copied as its `workflow/2`
equivalent (`processDraftFromPlaybook`).

### Visual builder and code view

The web editor lives at `/app/:organizationId/workflows/drafts/:draftId` with
**Build**, **Code** and **Test** views over one draft. The builder is a vertical,
forward-only step list, not a node canvas. A palette beside the list offers only
vocabulary entries, grouped and colour-coded by step type (`step-kinds.tsx`,
`--kind-*` in `authoring.css`); authors drag an entry between steps, or pick an
insert point and select the entry. On small screens the palette opens as a bottom
sheet from the insert point. Steps reorder by their drag handle (pointer or
keyboard, via `@dnd-kit`) or the step menu. Field pickers offer only values
available at that point, and adding an action also adds its result check.
Changes are validated on the server shortly after each edit, so a reorder that
breaks a reference is flagged immediately. The
editor autosaves against the loaded revision, keeps undo within the session and
shows a conflict instead of overwriting another editor's save. **Publish** asks
for version notes and states that publishing does not activate the workflow.

The code view prints the draft as `export default defineWorkflow({ … });` with
Code Step source in `` code`…` `` template literals (`printWorkflowSource`). The
server parses it back (`parseWorkflowSource`) reading literals only — never
imports, expressions or `${…}`. Printing, parsing and printing again is
byte-identical. Comments and formatting are kept verbatim in the draft; the
builder then stays read-only until the author switches back to the standard
format. Narrow screens show code read-only. The Code Step editor offers completion
for `input` fields and `luma.request` grants, flags imports, exports, async code and
`require` before saving, and publication binds the source to the pinned runtime
under the Code Step rules in [Code Steps](code-steps.md).

### Design-partner acceptance run

LUMA-88 is complete when a non-engineer creates, tests, publishes and activates a
workflow from a template and from scratch in each authoring mode. Run it in a
workspace with the Code Step runtime, the workflow worker and, for describing,
the EU `authoring` route configured:

1. **Template:** use **Replenish low stock** from the gallery, then customize a copy.
2. **Visual builder:** build a computation workflow with a Code Step and a condition.
3. **Code view:** change a value and a Code Step in the code view.
4. **Describe it:** describe a workflow, answer its questions and accept one refinement.
5. For each: add a saved test, publish with notes, and activate or start it.

Record the date, participant role, workspace, each mode's result and any blockers
here. Status: not yet run.

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

### Resolution journey acceptance (LUMA-72 / LUMA-37)

Activity shows the trigger, recorded investigation findings, decision and human
input, proposed action, execution status, and verification result. The Workflow
API supplies these readable summaries in `story`; raw references remain available
for inspection. Missing findings fall back to the linked diagnosis revision.
Provider success never establishes a verified correction by itself.

Run `pnpm test:browser playbooks.browser.mjs` for the Workflow journey on desktop
and narrow screens. It checks approval waiting, successful execution with
inconclusive verification, activation controls, and absence of Playbook language
in the rendered primary view. Screenshots are written to `/tmp/luma72-browser`.
The suite seeds recorded runs in an isolated database and reads them through the
real API. LUMA-37's broader simulator and execution acceptance remains a separate
gate.

## General triggers

Each immutable version declares one trigger: `manual`, `schedule`, `event`,
`condition`, or `exception`. A schedule specifies one UTC `at` timestamp. A
condition matches one declared context field to a typed scalar; producers can
supply a normalized `belowThreshold` fact for replenishment. Events use their
context kind as the event type. These contracts introduce no event bus or
expression language.

Owners and admins submit signals to
`POST /v1/organizations/:organizationId/workflows/:definitionId/starts`.
The request includes the reviewed version digest, explicit subject kind and ID,
source ID and occurrence time, and a typed input/evidence snapshot. The server
binds tenant and actor from the refreshed authenticated context. A resource ID
is an explicit scope reference, not evidence of ownership or execution access.
Execution admission must independently resolve and authorize that resource.

Deduplication covers tenant, exact version, subject, trigger kind and source ID.
Schedules use their versioned timestamp instead of a caller-selected source ID.
Retry the complete original request. Changed evidence for the same source returns 409. Event, condition and detection evidence must be fresh and match the
version's context. Resolution's existing detection path and run projections
remain supported.

A start produces a `WorkflowRun` with immutable context and trigger evidence.
It grants no activation, permission artifact or action approval. General runs
wait at `awaiting_admission`; the native execution adapter remains a separate
runtime concern. Run history distinguishes scheduled, cancelled and started runs
from action execution and verification.

Scheduled starts persist in PostgreSQL. The workflow worker advances due starts
in atomic, locked batches; competing workers skip locked rows. A crash before
commit leaves the start pending, and downtime does not drop overdue starts.
The narrowly scoped `advance_workflow_schedules()` function returns only a count,
never cross-tenant payloads, and cannot dispatch actions. The worker retries
failures. Cancellation races with firing on the same row lock and succeeds only
while pending. Run `pnpm dev:workflows` to process local schedules.

The Rules section displays the exact trigger contract and offers typed submission,
retry and resource controls. Activity shows evidence references and scheduled
start cancellation. Schedule times display in the workspace timezone; observation
entry explicitly uses the browser's local timezone.

## Readiness

Every workflow summary carries `readiness` (`workflowReadinessSchema`). It answers
whether a workflow is on, whether it can run, what it covers and what should happen
next, without the reader interpreting grants or versions.

- `enablement` (`enabled`, `paused`, `not_enabled`) is whether people turned it on:
  an active activation or stock rule, only revoked ones, or none. `state` (`ready`,
  `degraded`, `blocked`) is whether it can run. They are independent: an enabled
  workflow whose connection lost access is enabled and blocked. Never derive one
  from the other, and never relax authority to make a state look healthy.
- `issues` carry a severity, an affected record (`scope`) and a `repair` with a
  closed `destination` (`connections`, `suppliers`, `inventory_position`,
  `needs_you`, `workflow_rules`, …, or `server` when only the operator of the Luma
  server can fix it). `blocking` stops the workflow; `degrading` stops part of its
  coverage.
- `coverage.covered` and `waiting.count` are `null` when Luma can't establish them.
  The UI shows Unknown, never zero.
- `approval` comes from `approvalRequirement` in `@luma/policies`, which applies
  the same rules as admission (`evaluatePolicy`) with the current workspace setting.
  A capability floor of medium risk means every action waits for a person; quantity
  thresholds only raise risk.
- `outcomes` summarize the 50 most recent runs. Only a verified result counts as
  verified; runs that ended without acting are neither verified nor unresolved.
- `nextAction` comes from `assessReadiness`: the first blocking issue, then waiting
  decisions, partial coverage, setup, and the latest unresolved run.

Owners compute their facts: the shipping-method library from connection access,
active grants and mapped orders (`playbook-library.ts`); replenishment from the
worker, suppliers, rule stock freshness, pending decisions and runs
(`replenishment-workflow.ts`, with copy in `domain/replenishment-readiness.ts`);
custom versions from adapter blockers (`catalog.ts`).

`GET /workflow-coverage?subjectKind=inventory_position&subjectId=…` returns the
same readiness scoped to one record, so stock and purchase-order pages show what
the workflow overview shows. It returns 404 for records outside the workspace.
Record links carry `from` so their Back link returns to the original context.

## Case workflows

Case workflows are built-in `workflow/2` versions with an `exception` trigger.
They start a run for each open case of their issue type and run on the process
runtime, so runs, step evidence, Activity and readiness work as for replenishment.
`createCaseWorkflows` (`application/case-workflows.ts`) owns activation, starts,
readiness and the activities; each `CaseWorkflowAdapter` owns its reads, action
and result check.

| Workflow                   | Owner              | Trigger              | Action                          | Result check                          |
| -------------------------- | ------------------ | -------------------- | ------------------------------- | ------------------------------------- |
| `shopify-stock-correction` | Shopify app        | `inventory_mismatch` | `inventory.available.reconcile` | `shopify-inventory-reconciliation/1`  |
| `shopify-hold-release`     | Shopify app        | `stuck_fulfillment`  | `fulfillment.hold.release`      | `shopify-hold-released/1` (hold gone) |
| `connection-sync-check`    | `@luma/resolution` | `sync_failure`       | none; waits and rereads         | none                                  |

Apps contribute adapters through `AppDefinition.workflows`; the app registry
lists them with `workflowSources()`.

- **Activation:** `POST /workflows/:definitionId/case-activations` turns a
  workflow on for the workspace as the caller, after they reviewed the version
  digest and policy version. One activation can be active per workflow
  (`workflow_case_activations`, migration `0053`). Revoking uses the normal
  activation revoke route. Activation grants no approval.
- **Starts:** the workflow worker calls `tick` for each principal returned by
  `case_workflow_worker_scopes()`. It recovers committed runs, then records at
  most one run per case and version for open cases whose `lastDetectedAt` is
  within the version's `maxAgeSeconds`. Older open cases wait until detection
  confirms them again. At most 20 runs per workflow are unfinished at once. The
  run is persisted before Temporal starts it under its stable ID. Manual starts
  of case workflows return 409.
- **Actions:** the Shopify adapters call the app's existing correction and
  recovery services as the run's principal: persisted preview, policy approval
  by a different owner or admin in Needs you, execution by the requester,
  claims, compare-and-set or hold identity, and reconciliation. Previews stay
  open for a four-hour decision window. A preview whose change differs on a
  fresh read is replaced with one new proposal, up to 12 times, and Needs you
  keeps one item for the target while it waits. A rejection, policy denial, withheld write or uncertain write ends
  the attempt. Turning the workflow off, or the case closing, stops any change
  that wasn't sent; sent changes still reconcile.
- **Closure:** runs never close cases. Detection verifies them independently.

Readiness reports enablement, worker availability, adapter requirements (such as
Shopify write access), open cases of the type, waiting approvals and recent
outcomes. The web domain view is `apps/web/src/features/workflows/case.tsx`.

Validation: `application/case-workflows.test.ts`,
`packages/resolution/src/application/connection-check.test.ts` and
`apps/api/e2e/case-workflows.e2e.mjs`, which runs stock correction, rejection,
turning off, hold release and the connection check against the simulator and
Temporal.

## Domain views

The Workflow detail API can return a `presentation` key. The web registry in
`apps/web/src/features/workflows/domain-views.ts` maps known keys to domain
controls and run context. Missing or unknown keys retain the standard view.
Shared library, versions, activation history and step evidence remain unchanged.
Register domain renderers here instead of checking definition IDs in the shared
Workflow page.

`procurement.replenishment` uses the authorized replenishment review API for
recorded stock, immutable rule thresholds, supplier, policy decision, current
purchase order and verification evidence. The order must match both the bound
action target and run provenance. Current order status is separate from the
historical verification result. Activity search accepts the run ID and includes
policy and execution events associated through action admission.

## Test a draft

Authors can run a draft revision against example data before publishing. A test
runs the compiled draft through the production `workflow/2` interpreter
(`runProcess`). Example replies stand in for every read, approval, action and
result check, so a test never calls a connector, Action Admission, a capability
adapter or Temporal, and it records nothing in run history. Tests are evidence
for the author, not verification of business success. A passing test grants no
activation or approval; Shadow Mode remains the production evaluation path.

A test case holds inputs, context facts and replies keyed by step ID:

- A read returns its example values.
- An approval is `approved`, `denied` or `pending`. A missing approval reply
  means nobody has decided, so the run pauses there.
- An action is `accepted`, `approval_required` or `denied`.
- A result check is `verified`, `failed` or `inconclusive`, with its values.

Inputs, context facts and read or result-check values must match the declared
fields exactly. Every read the workflow performs itself and every action needs
a reply; a result check needs one when its action is accepted. Mismatches are
reported in plain language on the step and field to change.

Runs use a virtual clock that starts at `2026-01-01T00:00:00.000Z`. Waits
advance it instantly. Where a person would decide, such as a pending approval
or an action that needs approval, the run stops with outcome
`awaiting_decision`. Code Steps run in the Wasmtime sandbox with the step's own
limits when `LUMA_CODE_RUNTIME_DIR` is configured. They receive the same input
as in production and follow the Code Step evaluator's rules: a granted read
returns its reply, and an accepted action returns its result check's values
when that check is verified. Any other request is denied. Without the runtime,
tests of drafts with Code Steps fail with a plain reason.

A result lists each step the run reached in order: its last state, the values
it used and produced, the branch taken (`continued`, `ended`, `escalated`,
`paused` or `denied`) and a business-language note. Steps a Code Step requested
follow that Code Step. The result also has the final outcome, a plain reason
and whether it matched the case's expected outcome.

Example data can be prefilled from `GET .../workflow-drafts/:draftId/test-examples`:
empty values from the declared fields, up to ten recent runs of the published
workflow the draft edits, and scenarios from installed adapters. Recent runs
are read with the caller's refreshed tenant and membership. Replenishment
contributes its six simulator scenarios. Their replies apply to any draft step
with the same read source, action or result check, so customized copies of the
template get them too.

Owners and admins save up to 20 cases with `PUT .../tests` against the tests
revision they loaded (0 before any are saved). A stale revision returns 409;
retrying the same body is safe. `POST .../tests/run` runs every saved case that
has no completed or running result on the current draft revision. Run IDs
derive from the revision and case, so repeating the call is safe. The builder
calls it after each save and the publish dialog calls it before publishing.
`GET .../tests` returns each case's latest result on the current revision, or
why the draft cannot be tested.

`POST .../test-runs` starts one run with a saved case ID or an unsaved case
against the current draft revision; an older revision returns 409. Reuse the
same ID and body after an uncertain response; a different body for that ID
returns 409. Poll `GET .../test-runs/:runId` and stop a run with
`POST .../test-runs/:runId/cancel`. Each API process runs at most two jobs at a
time, where a batch of saved cases counts as one, and returns 503 when busy.
Cases in a batch run one after another. A run's deadline is the Code Steps'
wall time plus five seconds, multiplied by its position in a batch. A run left
running past its deadline reads as failed and can be run again.

Members can read saved cases, results and examples. Owners and admins save,
run and cancel. A run belongs to the person who started it; others get 404.
Migration `0035_workflow_draft_tests.sql` stores cases and runs under tenant
row-level security.

Validation: `packages/workflows/src/domain/draft-test.test.ts`,
`infrastructure/draft-tests.test.ts` (interpreter reuse, pauses, retries,
cancellation, sandbox limits and isolation), `infrastructure/draft-test-code.test.ts`
(the replenishment code corpus from `pnpm evaluate:code`),
`packages/application-runtime/src/composition/draft-tests.test.ts` (simulator
matrix outcomes) and `apps/api/e2e/workflow-draft-tests.e2e.mjs`.

## Describe a workflow

Owners and admins can describe what should happen and get a draft to review,
test and publish. The model is an author, not an authority: a generated draft
goes through the same validation, tests, publication, activation, Action
Admission and verification as a hand-built one. Generation never publishes,
activates, approves or starts a workflow.

- **Availability:** `GET /workflow-authoring/generation` returns
  `{ available, reason }` to members. Describing needs the `authoring` Model
  Gateway route on `bedrock-eu` with zero data retention and Bedrock settings
  (see [Model gateway](model-gateway.md#workflow-authoring-profile)). Without
  it, every generation request returns 503 with that reason and no model is
  called. Roles are checked first, so members get 403.
- **Describe:** `POST /workflow-authoring/describe` with
  `{ id, draftId, prompt }` creates draft `draftId` in `language` mode. The
  response has the draft and `generation`: an explanation per step,
  assumptions, open questions, remaining diagnostics, attempts, token usage and
  the model route. Each question has a `stepId` (null for workflow settings)
  and a `field` path in the same form as diagnostics, such as
  `parameters.quantity`, so the builder highlights that field. The model is told
  to leave ambiguous values empty and ask instead of guessing. New drafts start
  at version 1.0.0 with the model's definition ID plus a suffix from the draft ID.
- **Refine:** `POST /workflow-drafts/:draftId/proposals` with
  `{ id, revision, instruction }` returns a proposal: the complete proposed
  content and step-level `changes` (`added`, `removed`, `changed`, `moved`).
  Steps match by ID; a step is `moved` when its order relative to the other
  kept steps changed. Workflow settings have a null `stepId` and name the
  setting in `field`. The draft is unchanged, and refinement can't change its
  definition ID or version. `POST .../proposals/:proposalId/accept` with
  `{ revision, saveId }` applies the proposal through the normal draft save; if
  the draft changed after the proposal's base revision, it returns 409 and
  nothing is applied. `POST .../proposals/:proposalId/reject` discards it.
- **Code Steps:** `POST /workflow-drafts/:draftId/code-step-suggestions` with
  `{ id, revision, stepId, description }` returns source, fields, grants, an
  explanation and examples in the Code Step evaluator's format (`input.inputs`,
  `input.evidence`, `input.steps`, `replies`, `expected`). `stepId` names a
  Code Step in the saved draft; null asks for a new step before the last step.
  Examples may use only the values in scope there, and grants only the reads and
  actions directly after the step. Nothing is saved. Without a Code Step
  runtime the request returns 409.
- **Retries:** every command takes a request `id`. The same ID and body return
  the stored result; another body returns 409. A failed request is recorded
  under its own ID, so the same request can be sent again.

**Server checks.** The output schema sent to the model lists only this
workspace's installed vocabulary: subjects, data sources and their fields,
actions with their values and risk floor, result checks, and Code Steps when the
workspace can run or evaluate them. The server doesn't rely on the schema. Every
answer goes through draft validation (`checkDraftContent`, `checkVocabulary` and
the publication checks); errors go back to the model, up to three model calls
per request. The readable answer with the fewest errors is kept. Before it is
saved or proposed, uninstalled subjects, data sources, actions and result checks
are cleared and become questions, and fields or values an installed entry
doesn't declare are dropped. Generated drafts therefore only contain installed
vocabulary. Remaining errors come back as diagnostics with outcome `partial`.
Model errors, the 60-second deadline per request, client cancellation and
answers that never parse return 503 with a retry message; no draft is created
and a refined draft is unchanged.

**Data handling.** Generation authorizes the caller before building any model
input, then sends the request text, the current draft and the vocabulary with
`authoringModelProfile` and
`dataPolicy: { classification: 'sensitive', region: 'EU', zeroDataRetention: true }`.
Request text and model answers are never logged or traced, and error messages
never include model text. Request text is stored only as a hash; generated
drafts, proposals and suggestions are stored as workspace content.

**Provenance.** `workflow_generations` (migration `0036`, tenant row-level
security) records each request: kind, draft, base and resulting revision, the
prompt version (`workflow-authoring/1`), the hash of the request text, model
route, token usage, attempts, outcome and, for proposals, the decision. Members
read a draft's records at `GET /workflow-drafts/:draftId/generations`. The
records show authorship; they approve nothing. A failed describe request has no
draft, so it isn't listed.

### Authoring evaluation

`tooling/evaluation/fixtures/authoring-corpus.json` holds described workflows and
their references: the replenishment workflow (`replenishmentSource`), the
shipping-method correction
(`processDraftFromPlaybook(shippingMethodPlaybook, 'resolution')`) and four
computation workflows. It also holds a snapshot of the installed vocabulary;
`workflow-generation.e2e.mjs` fails when it no longer matches a new workspace.

With the `authoring` route configured, run
`pnpm evaluate:authoring [corpus.json] [report.json]`. Each description goes
through the production prompts, output schema, re-asks and checks. The report
(default `.luma/evaluations/authoring.json`) gives the valid-draft rate (drafts
without errors) and the equivalence rate (same trigger kind, ordered step kinds,
data sources, actions, result checks and condition fields as the reference),
with the differences for each case.

**Recorded baseline: pending.** No EU route credentials were available when the
feature was built, so no model has been evaluated yet. Before design-partner
use, run the command against the production route and record the date, model,
prompt version, corpus version, valid-draft rate and equivalence rate here.

Validation: `packages/workflows/src/domain/draft-generation.test.ts`,
`infrastructure/draft-generation.test.ts` (fake gateway: vocabulary-limited
schema, re-asks, bounded retries, partial drafts, failures, timeouts,
cancellation, proposals, Code Steps and the data policy),
`packages/application-runtime/src/composition/authoring.test.ts`,
`apps/api/e2e/workflow-generation.e2e.mjs` (unavailable route, roles, tenant
isolation, and describe, refine and accept through the real Bedrock adapter with
intercepted HTTPS) and `tooling/evaluation/authoring.test.mjs`.
