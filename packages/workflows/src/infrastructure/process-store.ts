import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { processInstructions } from '../domain/code-grants.js';
import type { ProcessStepOutput } from '../domain/process.js';
import { canonicalPlaybook } from './playbooks/schema.js';
import { compileProcessWorkflow } from './process-schema.js';

const typeOf = (value: unknown) => (value === null ? 'null' : typeof value);

function validateOutput(
  output: ProcessStepOutput,
  step: ReturnType<typeof compileProcessWorkflow>['steps'][number],
) {
  const allowed: Record<
    ProcessStepOutput['kind'],
    ProcessStepOutput['state'][]
  > = {
    code: ['waiting', 'completed', 'escalated'],
    read: ['completed'],
    condition: ['completed', 'ended', 'escalated'],
    capability: ['waiting', 'completed', 'escalated'],
    approval: ['waiting', 'completed', 'denied'],
    wait: ['waiting', 'completed'],
    verification: ['completed', 'failed', 'inconclusive'],
    escalation: ['escalated'],
    end: ['completed'],
  };
  if (
    output.kind !== step.kind ||
    !allowed[step.kind].includes(output.state) ||
    !output.evidenceRefs.length ||
    !Number.isFinite(Date.parse(output.recordedAt))
  )
    throw new Error('Step evidence does not match the published version');
  if (
    step.kind === 'read' ||
    step.kind === 'verification' ||
    (step.kind === 'code' && output.state === 'completed')
  ) {
    if (
      Object.keys(output.values).length !== Object.keys(step.fields).length ||
      Object.entries(step.fields).some(
        ([name, type]) =>
          !Object.hasOwn(output.values, name) ||
          typeOf(output.values[name]) !== type,
      )
    )
      throw new Error('Step output does not match its declared fields');
  }
  if (
    step.kind === 'read' &&
    (!output.observedAt ||
      !Number.isFinite(Date.parse(output.observedAt)) ||
      Date.parse(output.observedAt) > Date.parse(output.recordedAt))
  )
    throw new Error('Read output must include its observation time');
  if (
    step.kind === 'condition' &&
    (typeOf(output.values.matched) !== 'boolean' ||
      output.state !==
        (output.values.matched
          ? 'completed'
          : step.onFalse === 'end'
            ? 'ended'
            : 'escalated'))
  )
    throw new Error('Condition output must match its decision');
  if (
    step.kind === 'approval' &&
    output.state !== 'waiting' &&
    (typeOf(output.values.approved) !== 'boolean' ||
      output.values.approved !== (output.state === 'completed'))
  )
    throw new Error('Approval output must match its decision');
  if (
    step.kind === 'capability' &&
    typeOf(output.values.proposalId) !== 'string'
  )
    throw new Error('Action output must reference its proposal');
  if (step.kind === 'end' && output.values.outcome !== step.outcome)
    throw new Error('End output does not match the published outcome');
}

/** Persists typed step evidence under the triggering run and rejects conflicting replay. */
export function createProcessStepStore(db: TenantDatabase) {
  return {
    async record(
      context: TenantContext,
      runId: string,
      output: ProcessStepOutput,
    ) {
      await db.transaction(context.tenantId, async (tx) => {
        const run = (
          await tx.query<{
            id: string;
            state: string;
            version_digest: string;
            version: unknown;
          }>(
            "SELECT r.id,r.state,r.version_digest,v.document AS version FROM workflow_trigger_runs r JOIN playbook_versions v ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version WHERE r.tenant_id=$1 AND r.id=$2 AND r.document->'actor'->>'id'=$3 FOR UPDATE OF r",
            [context.tenantId, runId, context.actor.id],
          )
        ).rows[0];
        if (!run) throw new Error('Workflow run not found');
        if (run.state !== 'awaiting_admission')
          throw new Error('Workflow run is not ready to execute');
        const version = compileProcessWorkflow(run.version);
        if (version.digest !== run.version_digest)
          throw new Error('Workflow run version binding changed');
        const step = version.steps.find((item) => item.id === output.stepId);
        if (!step) throw new Error('Workflow step not found');
        validateOutput(output, step);
        const records = await tx.query<{ document: ProcessStepOutput }>(
          'SELECT document FROM workflow_process_steps WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence',
          [context.tenantId, runId],
        );
        const repeated = records.rows.find(
          ({ document }) =>
            document.stepId === output.stepId &&
            document.state === output.state,
        );
        if (repeated) {
          if (
            canonicalPlaybook(repeated.document) !== canonicalPlaybook(output)
          )
            throw new Error(
              'Workflow step replay conflicts with recorded evidence',
            );

          return;
        }
        const instructions = processInstructions(version);
        const index = instructions.findIndex(
          (item) => item.id === output.stepId,
        );
        if (index < 0)
          throw new Error(
            'Capability-owned nodes must execute through their Code Step',
          );
        const previous = records.rows.at(-1)?.document;
        const previousIndex = instructions.findIndex(
          (item) => item.id === previous?.stepId,
        );
        if (
          previous
            ? previousIndex === index
              ? previous.state !== 'waiting' || output.state === 'waiting'
              : previousIndex !== index - 1 || previous.state !== 'completed'
            : index !== 0
        )
          throw new Error('Workflow step is out of order or already terminal');
        await tx.query(
          'INSERT INTO workflow_process_steps(tenant_id,run_id,step_id,state,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [context.tenantId, runId, output.stepId, output.state, output],
        );
      });
    },
    async list(
      context: TenantContext,
      runIds: string[],
    ): Promise<Map<string, ProcessStepOutput[]>> {
      if (!runIds.length) return new Map();

      return db.transaction(context.tenantId, async (tx) => {
        const rows = await tx.query<{
          run_id: string;
          document: ProcessStepOutput;
        }>(
          'SELECT run_id,document FROM workflow_process_steps WHERE tenant_id=$1 AND run_id=ANY($2::uuid[]) ORDER BY sequence',
          [context.tenantId, runIds],
        );
        const records = new Map<string, ProcessStepOutput[]>();
        for (const row of rows.rows)
          records.set(row.run_id, [
            ...(records.get(row.run_id) ?? []),
            row.document,
          ]);

        return records;
      });
    },
  };
}
