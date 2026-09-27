# Multi-step Workflow runtime

Workflow versions with `format: workflow/2` use a bounded, forward-only step list. The compiler accepts reads, deterministic conditions, capability actions, decisions, waits, verification, escalation and end. Explicit decision steps are optional; Action Admission still applies policy approval to every capability action. An action may create a resource different from the triggering subject, with its target bound by the business adapter. Step IDs are unique within the immutable version. The version digest covers the complete contract. `workflow/1` and Resolution Playbook versions retain their existing representation and interpreter.

## Ownership

- `packages/workflows/src/infrastructure/process-schema.ts` validates the version and typed snapshots.
- `packages/workflows/src/application/process-runtime.ts` interprets one exact version. Reads and verification must return declared fields and evidence references. A failed or inconclusive verification ends the run in its own state.
- `packages/workflows/src/application/process-activities.ts` refreshes the actor and stored run, reloads the published version, binds each action, and invokes Action Admission with that action's `runId` and `stepId`. The capability adapter must persist an immutable action binding. Action Admission owns retries, approval and dispatch idempotency.
- `packages/workflow-temporal/src/process-workflow.ts` provides durable waits, decision signals, progress queries and replay. `createProcessClient` and `createProcessWorker` use a process task queue so only workers with the required activities receive these runs.
- `workflow_trigger_runs` stores trigger identity and the input snapshot. `workflow_process_steps` stores append-only outputs keyed by run, step and state. A conflicting activity replay is rejected. The Workflow API projects those records into recent runs; the web page shows their state and evidence timeline.

## Connecting a business capability

Provide `ProcessActivities` through `createProcessActivities`. Its adapter reads authoritative data, checks a persisted human decision, binds a capability-specific action, and verifies the postcondition. `bindAction` must use the published action node, current grants, typed snapshot and previous read outputs. Its returned proposal ID must refer to the persisted bound action. The shared activity then calls Action Admission for that specific step and checks the receipt binding. Start a Temporal run only after the trigger run has committed, using the same stored version digest. Signal a decision only after its decision record commits; the signal carries no authority.

Use the same process queue for its client and worker. A process worker requires the capability adapter for every read, action and verification it can execute. Existing exception workers continue on their own queue. This runtime does not infer authorization or verified success from a trigger, a decision signal, or a provider dispatch receipt.

[Replenishment](replenishment.md) wires this runtime to native activations, stock
conditions, human policy decisions and independently verified purchase orders.
