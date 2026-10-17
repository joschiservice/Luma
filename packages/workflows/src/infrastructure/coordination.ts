import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { canonicalJson, conflict, invalid } from '@luma/platform';

import type { CoordinationStore } from '../application/coordination.js';
import type { WorkflowAuditEntry } from '../application/drafts.js';
import type { HumanTask, WorkflowEvent } from '../domain/coordination.js';
import { matchesEventFields } from '../domain/coordination.js';
import type {
  ProcessRun,
  ProcessStepOutput,
  ProcessValue,
} from '../domain/process.js';
import { compileProcessWorkflow } from './process-schema.js';

function correlation(
  value: ProcessValue,
  run: ProcessRun,
  outputs: ProcessStepOutput[],
): string {
  const stepId = value.source === 'step' ? value.stepId : null;
  const resolved =
    value.source === 'literal'
      ? value.value
      : value.source === 'input'
        ? run.context.inputs[value.field]
        : value.source === 'evidence'
          ? run.context.evidence.facts[value.field]
          : [...outputs]
              .reverse()
              .find(
                (item) => item.stepId === stepId && item.state === 'completed',
              )?.values[value.field];
  if (
    typeof resolved !== 'string' ||
    !resolved.length ||
    resolved.length > 2000
  )
    throw new Error('Event correlation must resolve to a nonempty string');

  return resolved;
}

/** Projects an overdue assignment without writing during queue reads. Activities persist escalation. */
function current(task: HumanTask, now: Date): HumanTask {
  return task.state === 'open' &&
    !task.escalatedAt &&
    Date.parse(task.dueAt) <= now.getTime()
    ? { ...task, assignee: task.escalationTarget, escalatedAt: task.dueAt }
    : task;
}

/** Stores event input and human answers under RLS, serializing against run cancellation. */
export function createCoordinationStore(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => {
    append(entry: WorkflowAuditEntry): Promise<void>;
  },
  now: () => Date = () => new Date(),
): CoordinationStore {
  async function append(
    tx: SqlTransaction,
    context: TenantContext,
    runId: string,
    stepId: string,
    type: string,
    details: Record<string, string>,
  ) {
    const run = (
      await tx.query<{ document: ProcessRun }>(
        'SELECT document FROM workflow_trigger_runs WHERE tenant_id=$1 AND id=$2',
        [context.tenantId, runId],
      )
    ).rows[0]?.document;
    const caseId = run?.context.inputs.caseId;
    const proposalId =
      typeof caseId === 'string' && /^[0-9a-f-]{36}$/.test(caseId)
        ? caseId
        : runId;
    const id = randomUUID();
    await audit({
      transaction: async (_tenant, operation) => operation(tx),
    }).append({
      id,
      tenantId: context.tenantId,
      eventKey: `human-task:${runId}:${stepId}:${type}`,
      eventType: `workflow.human_task_${type}`,
      schemaVersion: 1,
      occurredAt: now().toISOString(),
      actor: { kind: 'user', id: context.actor.id },
      correlationId: runId,
      proposalId,
      actionHash: '',
      evidenceRefs: [`workflow:${runId}:${stepId}`],
      details,
    });
  }

  const task = (context: TenantContext, runId: string, stepId: string) =>
    db.transaction(context.tenantId, async (tx) => {
      const row = (
        await tx.query<{ document: HumanTask }>(
          "SELECT t.document FROM workflow_human_tasks t JOIN workflow_trigger_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id WHERE t.tenant_id=$1 AND t.run_id=$2 AND t.step_id=$3 AND r.state='awaiting_admission' AND NOT EXISTS(SELECT 1 FROM exceptions e WHERE e.tenant_id=r.tenant_id AND e.id::text=r.document->'context'->'inputs'->>'caseId' AND e.state='resolved')",
          [context.tenantId, runId, stepId],
        )
      ).rows[0];

      return row ? current(row.document, now()) : null;
    });

  return {
    task,
    pending: (context) =>
      db.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ document: HumanTask }>(
            "SELECT t.document FROM workflow_human_tasks t JOIN workflow_trigger_runs r ON r.tenant_id=t.tenant_id AND r.id=t.run_id CROSS JOIN LATERAL (SELECT CASE WHEN (t.document->>'dueAt')::timestamptz <= $4::timestamptz THEN t.document->'escalationTarget' ELSE t.document->'assignee' END AS assignee) effective WHERE t.tenant_id=$1 AND t.state='open' AND r.state='awaiting_admission' AND NOT EXISTS(SELECT 1 FROM exceptions e WHERE e.tenant_id=r.tenant_id AND e.id::text=r.document->'context'->'inputs'->>'caseId' AND e.state='resolved') AND (effective.assignee->>'id'=$2 OR effective.assignee->>'key'=$3) ORDER BY (t.document->>'dueAt')::timestamptz,t.run_id,t.step_id LIMIT 100",
            [context.tenantId, context.actor.id, context.actor.role.id, now()],
          )
        ).rows.map((row) => current(row.document, now())),
      ),
    coordinate: (context, run, step, outputs, startedAt) =>
      db.transaction(context.tenantId, async (tx) => {
        const stored = (
          await tx.query<{
            state: string;
            document: ProcessRun;
            version: unknown;
          }>(
            'SELECT r.state,r.document,v.document AS version FROM workflow_trigger_runs r JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r',
            [context.tenantId, run.id],
          )
        ).rows[0];
        if (
          !stored ||
          stored.document.actor.id !== context.actor.id ||
          stored.document.versionDigest !== run.versionDigest ||
          stored.document.contextDigest !== run.contextDigest
        )
          throw new Error('Workflow run binding changed');
        const published = compileProcessWorkflow(stored.version);
        if (
          published.digest !== run.versionDigest ||
          !published.steps.some(
            (item) => canonicalJson(item) === canonicalJson(step),
          )
        )
          throw new Error('Coordination does not belong to this run version');
        const ref = `workflow:${run.id}:${step.id}`;
        if (stored.state === 'cancelled')
          return { state: 'cancelled', evidenceRefs: [ref] };
        if (stored.state !== 'awaiting_admission')
          throw new Error('Workflow run is not ready to execute');
        const caseId = stored.document.context.inputs.caseId;
        if (
          typeof caseId === 'string' &&
          (
            await tx.query(
              "SELECT 1 FROM exceptions WHERE tenant_id=$1 AND id::text=$2 AND state='resolved'",
              [context.tenantId, caseId],
            )
          ).rowCount
        )
          return { state: 'cancelled', evidenceRefs: [ref], record: true };
        if (step.kind === 'event_wait') {
          const deadline = new Date(
            Date.parse(startedAt) + step.timeoutSeconds * 1000,
          ).toISOString();
          const events = await tx.query<{ document: WorkflowEvent }>(
            `SELECT document FROM workflow_events WHERE tenant_id=$1 AND event_type=$2 AND correlation_key=$3 AND occurred_at >= $4::timestamptz AND occurred_at <= $5::timestamptz AND recorded_at <= $5::timestamptz AND NOT EXISTS(SELECT 1 FROM jsonb_each_text($6::jsonb) f WHERE jsonb_typeof(document->'values'->f.key) IS DISTINCT FROM f.value) AND (SELECT count(*) FROM jsonb_object_keys(document->'values'))=(SELECT count(*) FROM jsonb_object_keys($6::jsonb)) AND jsonb_array_length(document->'evidenceRefs')>0 ORDER BY occurred_at,source_id LIMIT 1`,
            [
              context.tenantId,
              step.eventType,
              correlation(step.correlation, run, outputs),
              run.createdAt,
              deadline,
              step.fields,
            ],
          );
          const event = events.rows
            .map((row) => row.document)
            .find((item) => matchesEventFields(step, item));

          return event
            ? {
                state: 'completed',
                values: event.values,
                evidenceRefs: event.evidenceRefs,
              }
            : { state: 'pending', evidenceRefs: [ref] };
        }
        let saved = (
          await tx.query<{ document: HumanTask }>(
            'SELECT document FROM workflow_human_tasks WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 FOR UPDATE',
            [context.tenantId, run.id, step.id],
          )
        ).rows[0]?.document;
        if (!saved) {
          for (const target of [step.assignee, step.escalationTarget]) {
            if (
              target.kind === 'person' &&
              !(
                await tx.query(
                  'SELECT 1 FROM workspace_people WHERE tenant_id=$1 AND user_id=$2 AND is_member',
                  [context.tenantId, target.id],
                )
              ).rowCount
            )
              throw new Error(
                'Human task assignee is not a current workspace member',
              );
          }
          saved = {
            runId: run.id,
            stepId: step.id,
            definitionId: run.definitionId,
            subject: run.subject,
            assignee: step.assignee,
            escalationTarget: step.escalationTarget,
            instructions: step.instructions,
            choices: step.choices,
            evidence: step.evidence,
            dueAt: new Date(
              Date.parse(startedAt) + step.dueAfterSeconds * 1000,
            ).toISOString(),
            createdAt: startedAt,
            escalatedAt: null,
            state: 'open',
            answer: null,
          };
          await tx.query(
            'INSERT INTO workflow_human_tasks(tenant_id,run_id,step_id,state,document) VALUES($1,$2,$3,$4,$5)',
            [context.tenantId, run.id, step.id, saved.state, saved],
          );
          await append(tx, context, run.id, step.id, 'created', {
            instructions: step.instructions,
            assignee: JSON.stringify(step.assignee),
          });
        }
        const effective = current(saved, now());
        if (canonicalJson(effective) !== canonicalJson(saved)) {
          await tx.query(
            'UPDATE workflow_human_tasks SET document=$4 WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3',
            [context.tenantId, run.id, step.id, effective],
          );
          await append(tx, context, run.id, step.id, 'escalated', {
            assignee: JSON.stringify(effective.assignee),
          });
        }
        if (effective.state === 'cancelled')
          return { state: 'cancelled', evidenceRefs: [ref], record: true };
        if (effective.answer)
          return {
            state: 'completed',
            values: {
              choice: effective.answer.choice,
              note: effective.answer.note ?? '',
              actorId: effective.answer.actorId,
              evidence: effective.answer.evidence.value,
            },
            evidenceRefs: [ref],
          };

        return { state: 'pending', evidenceRefs: [ref] };
      }),
    answer: (context, expected, answer) =>
      db.transaction(context.tenantId, async (tx) => {
        const run = (
          await tx.query<{ state: string }>(
            'SELECT state FROM workflow_trigger_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [context.tenantId, expected.runId],
          )
        ).rows[0];
        const saved = (
          await tx.query<{ document: HumanTask }>(
            'SELECT document FROM workflow_human_tasks WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 FOR UPDATE',
            [context.tenantId, expected.runId, expected.stepId],
          )
        ).rows[0]?.document;
        if (
          !saved ||
          run?.state !== 'awaiting_admission' ||
          saved.state === 'cancelled'
        )
          throw conflict('The task was cancelled.');
        if (saved.answer) {
          const { actorId, answeredAt, ...body } = saved.answer;
          void answeredAt;
          if (
            actorId !== context.actor.id ||
            canonicalJson(body) !== canonicalJson(answer)
          )
            throw conflict('This task already has an answer.');

          return saved;
        }
        const effective = current(saved, now());
        if (
          canonicalJson(effective.assignee) !== canonicalJson(expected.assignee)
        )
          throw conflict('The assignment changed. Refresh the task.');
        const document: HumanTask = {
          ...effective,
          state: 'answered',
          answer: {
            ...answer,
            actorId: context.actor.id,
            answeredAt: now().toISOString(),
          },
        };
        await tx.query(
          "UPDATE workflow_human_tasks SET state='answered',document=$4 WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3",
          [context.tenantId, expected.runId, expected.stepId, document],
        );
        await append(tx, context, expected.runId, expected.stepId, 'answered', {
          choice: answer.choice,
          note: answer.note ?? '',
          evidence: answer.evidence.value,
        });

        return document;
      }),
    deliver: (context, event) =>
      createWorkflowEventSink(db, now)(context.tenantId, event),
  };
}

/** Appends immutable input in the caller's tenant transaction. Runtime composition supplies trusted owner operations. */
export function createWorkflowEventSink(
  db: TenantDatabase,
  now: () => Date = () => new Date(),
) {
  return (tenantId: string, event: WorkflowEvent): Promise<void> =>
    db.transaction(tenantId, async (tx) => {
      if (Date.parse(event.occurredAt) > now().getTime())
        throw invalid('Event time cannot be in the future.');
      await tx.query(
        'INSERT INTO workflow_events(tenant_id,source_id,event_type,correlation_key,occurred_at,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [
          tenantId,
          event.sourceId,
          event.eventType,
          event.correlationKey,
          event.occurredAt,
          event,
        ],
      );
      const row = (
        await tx.query<{ document: WorkflowEvent }>(
          'SELECT document FROM workflow_events WHERE tenant_id=$1 AND source_id=$2',
          [tenantId, event.sourceId],
        )
      ).rows[0];
      if (canonicalJson(row?.document) !== canonicalJson(event))
        throw conflict('This event source already has different evidence.');
    });
}
