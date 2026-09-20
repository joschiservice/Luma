import { appendFile, readFile } from 'node:fs/promises';

import { buildRuntimeApp, createSafetyServices } from '../dist/app.js';

process.once(
  'message',
  async ({ databaseUrl, secret, origin, cookie, action, ledger, mode }) => {
    const app = buildRuntimeApp({
      databaseUrl,
      secret,
      baseURL: origin,
      trustedOrigins: [origin],
    });
    let context;
    // Resolve a branded context through the real authentication and tenant guards.
    app.get(
      '/v1/organizations/:organizationId/e2e-context',
      async (request) => {
        context = request.tenantContext;

        return {};
      },
    );

    async function resolveContext() {
      const response = await app.inject({
        url: `/v1/organizations/${action.tenantId}/e2e-context`,
        headers: { cookie, origin },
      });
      if (response.statusCode !== 200 || !context)
        throw new Error('Unable to resolve worker identity');

      return context;
    }

    const adapter = {
      capability: 'stock.correct',
      version: '1',
      minimumRisk: 'low',
      mechanism: 'api',
      executor: { kind: 'connector', id: 'e2e-ledger' },
      checkPreconditions: async () => true,
      async execute(intent, key) {
        // This append-only fixture represents provider state outside the worker.
        // It deliberately does not deduplicate calls, so a resend remains visible.
        await appendFile(
          ledger,
          `${JSON.stringify({ proposalId: intent.id, key, quantity: intent.parameters.quantity })}\n`,
          { flush: true },
        );
        process.send({ type: 'effect-committed' });
        if (mode === 'interrupt') await new Promise(() => {});

        return { evidenceRefs: intent.preconditions.evidenceRefs };
      },
      async verify(intent) {
        const records = (await readFile(ledger, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));

        return {
          outcome: records.some(
            (record) =>
              record.proposalId === intent.id &&
              record.quantity === intent.parameters.quantity,
          )
            ? 'passed'
            : 'inconclusive',
          observationRefs: intent.preconditions.evidenceRefs,
          observedAt: new Date().toISOString(),
          evaluatorVersion: 'e2e-ledger-1',
        };
      },
    };
    const safety = createSafetyServices(
      databaseUrl,
      { refreshContext: resolveContext },
      { resolve: async () => adapter },
      { eligible: async () => true },
    );
    try {
      const actor = await resolveContext();
      const artifact = await safety.provisioning.activate(actor, {
        id: 'e2e-ledger',
        version: '1',
        generation: { kind: 'manual', reference: 'e2e-ledger/1' },
        steps: {
          execute: {
            capability: 'stock.correct',
            capabilityVersion: '1',
            targetKind: action.target.kind,
            minimumRisk: 'low',
          },
        },
      });
      await safety.provisioning.bind(actor, {
        tenantId: actor.tenantId,
        principalId: actor.actor.id,
        runId: action.id,
        stepId: 'execute',
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        incidentId: action.target.id,
        diagnosisRevision: 1,
        action,
      });
      const reference = { runId: action.id, stepId: 'execute' };
      const replay = await safety.execution.execute(actor, reference);
      if (mode === 'recover') {
        const reconciled = await safety.execution.reconcile(actor, action.id);
        const repeated = await safety.execution.execute(actor, reference);
        process.send({ type: 'recovered', replay, reconciled, repeated });
      } else {
        throw new Error(
          `Execution returned before interruption: ${replay.state}`,
        );
      }
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      await safety.close();
      await app.close();
      process.disconnect();
    }
  },
);
