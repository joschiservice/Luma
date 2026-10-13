# Workflow model

A Workflow is a versioned, immutable process that people author, publish, activate and run.
Publication never grants authority: every action a run proposes passes Action Admission
(authorization, policy, approval, reservation, idempotency and audit), and only an
independent read establishes the outcome.

`@luma/workflows` owns definitions, versions, drafts, activations, runs and step
provenance; `@luma/execution` owns admission and effects; `@luma/workflow-temporal`
provides durability. Workflows must not depend on Resolution or Exceptions. Resolution
definitions keep their own interpreter and format; see
[Resolution workflows](resolution-playbooks.md).

## Contracts

A version's digest covers its complete contract: trigger, subject kind, typed inputs and
context, step IDs, approval and risk requirements, verification, escalation and authorship.
A run binds the exact version and activation to a subject, an initiating actor and an
immutable context snapshot. Exception and diagnosis references are an optional Resolution
specialization, so manual and event-triggered workflows need no Exception.

`WorkflowActor` describes provenance (user, or agent with accountable operator and
delegation grant), not permission. Activation commands reject caller-supplied actor fields.
An agent adapter must resolve its grant through identity, refresh authorization for every
start or continuation, and enter the same activation, policy, approval, admission,
reservation, verification and audit path. An actor object never substitutes for an
authenticated tenant context.

Detail and run responses keep user IDs and list the people they reference in `people`, named
as in [Activity](workspace-activity.md#attribution) with one read per response. Version
authors that are not user IDs, such as `Luma`, are names already and are shown as recorded.
The catalog names people through a port that the runtime composition supplies; without it,
`people` is empty and screens show former members.

Run history separates dispatch from verification; an accepted provider write or a
completed activity never establishes verified business success. A run's readable `story`
falls back to the linked diagnosis revision when findings are missing.

## Authoring and runtime support

Every authoring mode (templates, the visual builder, the code view and natural language)
edits the same `workflow/2` draft and publishes through one path: compile, publish an
immutable version, activate with explicit grants, Action Admission, independent
verification, audit. Modes are views of a draft, not engines or permission paths.

A published version that no installed adapter can execute is shown as unavailable with
the reason and cannot be activated. Trigger metadata does not install a trigger handler.
Today the installed adapters run replenishment, the case workflows, and coordination or computation
custom workflows containing Code Steps, human tasks or event waits with conditions, timed waits,
escalations or ends. Code Steps require an installed runtime and no business grants. Custom workflows that need a
business read or action stay unavailable until a domain adapter installs that capability.

### Drafts and publication

Drafts are mutable, tenant-isolated authoring records. They never run and grant nothing.

- Saves carry the loaded revision; a stale one returns 409 and overwrites nothing. Creates
  and saves are idempotent by ID and body. Incomplete content autosaves; Code Steps get
  their runtime binding only at publication.
- Validation has no side effects. Errors block publication; warnings say what cannot run in
  this workspace yet.
- Publication re-authorizes `workflows.publish`, validates the exact saved revision, and
  stores the version, draft update and audit entry in one transaction. A new version must
  be higher than the latest published one; the same version with different content is
  rejected; retrying the same revision returns the same version. Publication never
  activates.
- Editing a published workflow starts a draft at the next minor version. Built-in
  definitions (replenishment, case workflows, shipping-method correction), Resolution and
  `workflow/1` definitions cannot become drafts: customize a template copy instead. The
  definition IDs `new` and `drafts` are reserved for routes.

### Vocabulary, templates and code view

Installed domain adapters contribute the authoring vocabulary: subjects, read sources,
capabilities with their parameters and risk floor, result checks and Code Step support.
Unknown entries, wrong value types and risk below a capability's floor are errors. Known
entries that cannot run here are warnings. The catalog uses the same check to explain why a
published custom version is unavailable.

Templates are published definitions offered by domain adapters, not a separate store.
Installing one publishes its reviewed version (idempotent, never activates). Using it
activates through the owner's normal path (replenishment rules, Resolution activation or a
case-workflow activation), so the same authorization and overlap checks apply. Customizing
creates a draft copy with a new ID; the template never changes. The shipping-method
correction is copied as its `workflow/2` equivalent.

The code view prints `export default defineWorkflow({ … });` with Code Step source in
`` code`…` `` literals. The server parses literals only, never imports, expressions or
`${…}`. Print, parse and print again is byte-identical. Hand-formatted text is kept
verbatim, and the builder stays read-only until the author returns to the standard format.

## Process runtime

`workflow/2` versions are bounded, forward-only step lists: reads, deterministic conditions,
capability actions, decisions, timed waits, human tasks, correlated event waits, Code Steps, verification, escalation and end. Step IDs
are unique within a version. An action may target a resource other than the triggering
subject; the business adapter binds that target. Explicit decision steps are optional;
admission still applies policy approval to every action.

- The interpreter runs one exact version. Reads and verification must return their
  declared fields and evidence references. Failed verification ends the run. Inconclusive reads
  can use a declared bounded recheck policy; exhausting it ends as inconclusive, never verified.
- Each activity refreshes the actor and the stored run, reloads the published version, and
  calls Action Admission with that action's `runId` and `stepId`. The capability adapter's
  `bindAction` must use the published action node, current grants, typed snapshot and
  earlier read outputs, and must persist an immutable action binding that its proposal ID
  refers to. Admission owns retries, approval and dispatch idempotency.
- Start the Temporal run only after the trigger run commits, with the same stored version
  digest. Signal a decision only after its decision record commits; the signal carries no
  authority.
- Step outputs are append-only, keyed by run, step and state. A conflicting activity replay
  is rejected.
- A suspended or closed workspace pauses its runs at the next activity, with the same
  bounded waits as [exception workflows](exception-workflows.md#authority-retries-and-recovery).
  Background starts and monitors skip the workspace until it is active again.
- Runs act as their principal, so a suspended principal pauses them the same way, and
  discovery skips the principal's activations, starts and submissions until the membership is
  reactivated. Removal is different: a removed principal's runs fail authorization.
- All process runs (replenishment, case, follow-up and computation workflows) share the
  `<taskQueue>-procurement` queue despite its name. Its client and worker must use the same
  queue, and the worker needs the adapter for every read, action and verification it can
  execute. Exception workers keep their own queue.

The runtime never infers authorization or verified success from a trigger, a decision
signal or a dispatch receipt.

### Human tasks and correlated waits

Human tasks publish a person or current role, instructions, a finite set of choices, required
text, HTTP(S) link or typed record evidence, an optional note and a due time with a fallback.
Answers are tenant-scoped and authorized against refreshed membership. One answer is retained
with its actor and timestamp; identical retries are harmless and conflicting answers return 409.
Temporal history rolls over at open coordination boundaries, preserving the deadline and earlier
receipts without repeating actions. Overdue tasks remain answerable by the escalation target. Task creation, escalation and answers
leave audit evidence. Cancellation or closure of a linked case removes open tasks. An answer
is workflow input, never approval or proof of provider success.

Order change plans (see [Orders workspace](orders-workspace.md#change-plans)) describe
person steps with a role and Luma steps with a capability; they create no tasks. The order
quantity change (below) asks the warehouse before Luma changes anything, so holds and
confirmations come before updates, and binds the Shopify step as a capability action. It
re-plans from fresh reads of every source after the answer: an answer confirms what a person
did, never that the change became safe or the provider applied it.

Event waits publish an event type, a string correlation key, exact typed payload fields and
a timeout recovery outcome. Deliveries are immutable by tenant and source identity. A wait
can consume input delivered after its run began, including input received before the wait
activity started. Occurrence and receipt must both precede the deadline. Duplicates cannot
change evidence; wrong keys, malformed payloads and late events cannot satisfy a wait.
Timeouts record an ended or escalated receipt. Supplier acknowledgment events are published
atomically with confirmed purchasing-system observations, keyed by the purchase order.

## Triggers

A subscription is an immutable revision separate from workflow logic. It pins a published
version digest and a trigger. Editing its active head requires the reviewed revision and
changes future starts only. Each start retains its exact subscription revision. Starts and
subscription edits serialize against the same head; historical run evidence is unchanged.
Legacy starts continue to use the version's trigger when no subscription is supplied.

Each version declares one trigger: `manual`, `schedule` (one UTC `at` time), `event` (its
context kind is the event type), `condition` (one declared context field against a typed
scalar) or `exception`. Trigger delivery is explicit; it grants no authority.

People with `workflows.triggers.manage` submit starts with the reviewed version digest, an
explicit subject, a source ID and occurrence time, and a typed snapshot. The server binds
tenant and actor from the refreshed context. A subject ID is a scope reference, not
evidence of ownership; admission resolves and authorizes the resource itself.

- Deduplication covers tenant, exact version, subject, trigger kind and source ID; schedules
  use their versioned time. Retry the complete original request; changed evidence for the
  same source returns 409. Event, condition and detection evidence must be fresh and match
  the version's context.
- A start creates a run with immutable trigger evidence and grants no activation,
  permission or approval. It waits at `awaiting_admission` until an installed adapter
  starts it.
- Scheduled starts persist in PostgreSQL. The workflow worker advances due starts in locked
  batches, so a crash leaves a start pending and downtime drops nothing.
  `advance_workflow_schedules()` returns only a count, never cross-tenant data, and cannot
  dispatch. Cancellation takes the same row lock and succeeds only while pending. Scheduled
  starts are recorded but do not run custom workflows yet.
- A start that comes due while its workspace is suspended or closed becomes `skipped` and
  never runs, so reactivation does not fire missed starts. Starts due after reactivation
  run at their time. Worker downtime is different: an active workspace's late starts still
  run.

## Readiness

Every workflow summary carries `readiness`: whether it is on, whether it can run, what it
covers and what should happen next.

- `enablement` (`enabled`, `paused`, `not_enabled`) says whether people turned it on.
  `state` (`ready`, `degraded`, `blocked`) says whether it can run. They are independent:
  an enabled workflow whose connection lost access is enabled and blocked. Never derive one
  from the other, and never relax authority to make a state look healthy.
- Each issue names an affected record and a repair destination; `server` means only the
  operator of the Luma server can fix it. `blocking` stops the workflow; `degrading` stops
  part of its coverage.
- `coverage.covered` and `waiting.count` are `null` when Luma cannot establish them. Show
  Unknown, never zero.
- `approval` comes from `approvalRequirement` in `@luma/policies`, which applies the same
  rules as admission with the current workspace setting. A medium capability floor means
  every action waits for a person; quantity thresholds only raise risk.
- `outcomes` cover the 50 most recent runs. Only a verified result counts as verified;
  runs that ended without acting are neither verified nor unresolved.
- `nextAction` picks the first blocking issue, then waiting decisions, partial coverage,
  setup and the latest unresolved run.
- A case workflow whose human tasks name a role needs an active member with that role, and
  one with the fallback role; otherwise its readiness blocks and turning it on is refused.
- `owner_suspended` means the workflow needs a new owner: the person whose access its runs
  use is suspended or their account disabled, so they pause. A case workflow blocks; replenishment degrades until every
  active rule is affected. Turning the workflow on again, or setting the rule up again, runs it
  with the new person's access. Runs already started keep their principal and continue only
  after reactivation or once the account is enabled.

Each owner computes its own readiness facts. The record-scoped coverage endpoint returns
the same readiness for one record, and 404 outside the workspace.

## Case workflows

Case workflows are built-in `workflow/2` versions. Those with an `exception` trigger start
one run per open case of their issue type. Follow-up workflows use an `event` trigger over
signals their owner reports. Apps contribute adapters through their app definition.

The built-in set is Shopify stock correction, hold release and the order quantity change,
the connection sync check, and the supplier, refund and payment follow-ups. Only the
Shopify workflows change provider state. The supplier follow-up's only write is `procurement.follow-up.record` on Luma's own
order, so its readiness reports that no approval is needed. The connection check and the
refund and payment follow-ups only reread and hand over.

- **Activation:** someone with `workflows.publish` turns a workflow on for the workspace
  after reviewing its version digest and policy version. One activation per workflow can be
  active. Activation grants no approval.
- **Starts:** the worker recovers committed runs, then records at most one run per case and
  version for open cases detected within the version's `maxAgeSeconds`; older cases wait
  for detection to confirm them again. At most 20 runs per workflow are unfinished. The run
  persists before Temporal starts it under its stable ID. Manual starts return 409.
- **Actions:** the Shopify adapters call the app's correction and recovery services as the
  run's principal: persisted preview, approval with `decisions.respond` under the [workspace rules](workspace-settings.md#approval-preference),
  execution by the requester, claims, compare-and-set or hold identity, and
  reconciliation. A preview stays open for four hours. A preview whose change differs on a
  fresh read is replaced, at most 12 times, and Needs you keeps one item per target. A
  rejection, policy denial, withheld write or uncertain write ends the attempt. Turning the
  workflow off or the case closing stops unsent changes; sent changes still reconcile.
- **Closure:** runs never close cases. Detection verifies them independently.
- **Responsibility:** the order quantity change gives a case nobody owns to the person whose
  access it runs with as soon as it hands work to people (a human task or an escalation), so
  an overdue or escalated case stays with someone. An existing owner is kept; without
  `decisions.assign` the case keeps its state and the run continues.
- **Order quantity change:** starts for `order_quantity_mismatch` cases whose sources include
  a Shopify store. Each read rereads every source of the order and plans the value the
  order-line authority reports, pinned for the rest of the run. Luma can't write dispatch
  records, so a human task always asks the Member role to make dispatch carry the new
  quantity, adjusting or resetting a started pick; it is due after four hours and then falls
  to admins, with the open task still answerable. After an `Adjusted` answer a fresh plan
  must show the change safe, otherwise the run escalates; it ends without a change when
  Shopify already shows the value. The Shopify edit then runs through the
  [order quantity edit](shopify-actions.md#order-quantity-edits), and one check confirms
  Luma's edit in Shopify and rereads every system: each one that reports the line must show
  the value, and systems that report none are counted apart.
- **Follow-ups:** signals come from owners and read models as the run's principal, so access
  checks apply. A signal ID names one occurrence, such as an order's submission, so a
  recorded follow-up does not start a second run. A handover appears in Needs you while the
  signal stays open; the supplier follow-up uses the order's own item instead. Default
  windows: 4 hours after a recorded supplier follow-up, 48 hours after returned items arrive,
  24 hours after an order was placed with payment pending; composition can change them.
  Follow-ups never issue refunds, place holds or cancel orders: no governed capability
  exists for them.

## Domain views

A workflow detail may carry a `presentation` key that the web registry maps to domain
controls; unknown keys keep the standard view. Register domain renderers there instead of
checking definition IDs in the shared page. The replenishment view shows a purchase order
only when it matches both the bound action target and the run provenance, and keeps the
order's current status separate from the historical verification result.

## Test a draft

Authors run a draft revision against example data before publishing. Tests use the
production `workflow/2` interpreter, but example replies stand in for every read, approval,
action and result check: a test never calls a connector, Action Admission, a capability
adapter or Temporal, and records nothing in run history. A passing test is evidence for the
author, not verification, and grants no activation or approval.

- A missing approval reply means nobody decided, so the run pauses. Every read and action
  needs a reply; a result check needs one when its action is accepted. Values must match
  the declared fields exactly.
- A virtual clock starts at `2026-01-01T00:00:00.000Z` and waits advance it instantly.
  Where a person would decide, the run stops with `awaiting_decision`.
- Code Steps run in the real sandbox with their own limits when the runtime is installed;
  a granted read returns its reply and an accepted action returns its verified check's
  values. Any other request is denied. Without the runtime, such tests fail with a reason.
- Up to 20 cases per draft, saved against a tests revision (stale returns 409). Run IDs
  derive from the draft revision and case, so repeating a run is safe; a different body for
  a run ID returns 409.
- Each API process runs at most two jobs at once (a batch counts as one) and returns 503
  when busy. A run's deadline is its Code Steps' wall time plus five seconds, multiplied by
  its position in a batch; a run past its deadline reads as failed.
- A run belongs to the person who started it; others get 404. Example prefill reads up to
  ten recent runs with the caller's refreshed membership.

## Describe a workflow

People with `workflows.author` describe what should happen and get a draft to review, test
and publish. The model is an author, not an authority: a generated draft goes through the
same validation, tests, publication, activation, admission and verification as a hand-built
one. Generation never publishes, activates, approves or starts anything.

- **Availability:** generation needs the `authoring` route on `bedrock-eu` with zero data
  retention (see [Model gateway](model-gateway.md#workflow-authoring-profile)). Without it,
  requests return 503 with the reason and no model is called. Permission is checked first.
- **Describe** creates a new draft with explanations and open questions tied to a step and
  field. The model leaves ambiguous values empty and asks instead of guessing.
- **Refine** returns a proposal with the full content and step-level changes; the draft is
  unchanged until accepted, and refinement cannot change the definition ID or version.
  Accepting goes through the normal save and returns 409 if the draft moved past the
  proposal's base revision.
- **Code Step suggestions** return source, fields, grants and examples without saving.
  Examples use only values in scope, and grants only the steps directly after the Code Step.
- **Retries:** every command takes a request ID. The same ID and body return the stored
  result; another body returns 409. Failed requests are recorded, so resending is safe.

**Server checks.** The output schema lists only the workspace's installed vocabulary, but
the server does not rely on it. Every answer goes through draft validation; errors go back
to the model, at most three calls per request, and the readable answer with the fewest
errors is kept. Uninstalled entries are cleared and become questions, and undeclared fields
are dropped, so generated drafts contain only installed vocabulary. Remaining errors return
as diagnostics with outcome `partial`. Model errors, the 60-second deadline, client
cancellation and unparseable answers return 503; no draft is created or changed.

**Data handling.** The caller is authorized before any model input is built, and requests
are `sensitive`, EU, zero-retention. Request text and answers are never logged or traced,
and errors never include model text. Request text is stored only as a hash; generated
content is workspace content. Generation records show authorship and approve nothing.

### Authoring evaluation

`tooling/evaluation/fixtures/authoring-corpus.json` holds described workflows with
references (replenishment, the shipping-method correction and computation workflows) and a
snapshot of the installed vocabulary. The generation E2E test fails when that snapshot no
longer matches a new workspace, so update it with vocabulary changes.

With the `authoring` route configured, `pnpm evaluate:authoring` sends each description
through the production prompts, schema, re-asks and checks. It reports the valid-draft rate
(no errors) and the equivalence rate: same trigger kind, ordered step kinds, data sources,
actions, result checks and condition fields as the reference. Record results with the
model, prompt version and corpus version in the pull request that changes them.

## Compatibility and storage

Native and Resolution workflows share one catalog owner without a data copy.

- The `playbook_*` tables, RLS, privileges and composite references stay; their SQL names
  are storage details. Native definitions use the same tables with a format discriminator
  and cannot reuse a legacy ID with different content.
- Serialized Resolution versions keep their SHA-256 digests, marked
  `resolution-playbook/0`. That digest covers the original definition, compatibility,
  provenance and IR, not the API projection.
- Legacy activation, run and outcome documents remain Resolution adapter records; the
  Workflow API projects them without changing them. New execution persistence goes through
  the Workflow owner instead of weakening legacy evidence constraints.
- Resolution's former exports forward to `@luma/workflows`; import the owner.
- The legacy `/playbooks` endpoints keep Resolution responses; native definitions appear
  only in the Workflow API. Both share activation records and transaction locks, so
  switching API paths cannot bypass overlap or replay checks. Old web URLs redirect with
  filters and anchors preserved.
