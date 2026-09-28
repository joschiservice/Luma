import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { CodeJournal } from '../../application/code-activity.js';
import type {
  CodeActivityResult,
  CodeCall,
  CodeStep,
} from '../../domain/code-step.js';
import type { ProcessRun } from '../../domain/process.js';
import { playbookHash } from '../playbooks/schema.js';

/** Persists first-writer replies under RLS; mismatched inputs or call order fail closed. */
export function createCodeJournal(
  db: TenantDatabase,
  context: (run: ProcessRun) => Promise<TenantContext>,
): CodeJournal {
  async function record(
    run: ProcessRun,
    step: CodeStep,
    key: string,
    value?: unknown,
  ) {
    const caller = await context(run);

    return db.transaction(caller.tenantId, async (tx) => {
      if (caller.tenantId !== run.tenantId || caller.actor.id !== run.actor.id)
        throw new Error('Code principal changed');
      if (value !== undefined)
        await tx.query(
          'INSERT INTO workflow_code_records(tenant_id,run_id,step_id,record_key,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [
            caller.tenantId,
            run.id,
            step.id,
            key,
            { artifactDigest: step.artifactDigest, value },
          ],
        );
      const row = (
        await tx.query<{
          document: { artifactDigest: string; value: unknown };
        }>(
          'SELECT document FROM workflow_code_records WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND record_key=$4',
          [caller.tenantId, run.id, step.id, key],
        )
      ).rows[0];
      if (row && row.document.artifactDigest !== step.artifactDigest)
        throw new Error('Code artifact changed');

      return row?.document.value;
    });
  }

  const digest = (run: ProcessRun, input: unknown) =>
    playbookHash({ input, now: run.createdAt });

  return {
    async result(run, step, input) {
      const binding = (await record(run, step, 'input', {
        digest: digest(run, input),
        input,
        now: run.createdAt,
      })) as { digest: string };
      if (binding.digest !== digest(run, input))
        throw new Error('Code input changed');
      const value = (await record(run, step, 'result')) as
        CodeActivityResult | undefined;
      if (value && value.telemetry.inputDigest !== digest(run, input))
        throw new Error('Code input changed');

      return value ?? null;
    },
    async calls(run, step) {
      const calls: CodeCall[] = [];
      for (let i = 0; i < step.limits.maxRequests; i++) {
        const call = (await record(run, step, `call:${i}`)) as
          CodeCall | undefined;
        if (!call) break;
        calls.push(call);
      }

      return calls;
    },
    async append(run, step, index, call) {
      const saved = (await record(
        run,
        step,
        `call:${index}`,
        call,
      )) as CodeCall;
      if (saved.grant !== call.grant) throw new Error('Code request changed');

      return saved;
    },
    async finish(run, step, input, result) {
      if (result.telemetry.inputDigest !== digest(run, input))
        throw new Error('Code input changed');

      return (await record(run, step, 'result', result)) as CodeActivityResult;
    },
    async cancelled(run, step) {
      return (await record(run, step, 'cancelled')) === true;
    },
  };
}
