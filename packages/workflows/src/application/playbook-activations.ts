import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import { currentPolicyVersion } from '@luma/policies';

import type { PlaybookActivation } from '../domain/playbook.js';
import type { PlaybookDependencies } from './playbook.js';

const artifactId = (id: string) => `playbook:${id}`;

/** Creates immutable activation and permanent revocation commands; each command re-checks playbooks.activate on the refreshed context. */
export function createPlaybookActivations(
  deps: Pick<
    PlaybookDependencies,
    'store' | 'provisioning' | 'refreshContext' | 'parseActivation'
  >,
) {
  async function authorize(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, 'playbooks.activate');
    if (fresh.actor.id !== context.actor.id)
      throw new Error('Playbook principal changed');

    return fresh;
  }

  return {
    async activate(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const request = deps.parseActivation(input);
      if (request.policyVersion !== currentPolicyVersion)
        throw new Error('Unsupported activation policy');
      const version = await deps.store.version(
        context,
        request.definitionId,
        request.version,
      );
      if (!version) throw new Error('Playbook version not found');
      const action = version.ir.action;
      const artifact = await deps.provisioning.activate(context, {
        id: artifactId(request.id),
        version: version.version,
        generation: { kind: 'manual', reference: version.digest },
        playbook: {
          versionDigest: version.digest,
          policyVersion: request.policyVersion,
          ...request.grants,
        },
        steps: {
          [action.id]: {
            capability: action.capability,
            capabilityVersion: action.capabilityVersion,
            targetKind: action.targetKind,
            minimumRisk: action.minimumRisk,
          },
        },
      });
      const activation: PlaybookActivation = {
        ...request,
        tenantId: context.tenantId,
        versionDigest: version.digest,
        artifactDigest: artifact.digest,
      };
      await deps.store.activate(context, activation);

      return activation;
    },
    async revoke(context: TenantContext, id: string) {
      context = await authorize(context);
      const activation = await deps.store.activation(context, id);
      if (!activation) throw new Error('Playbook activation not found');
      await deps.provisioning.revoke(
        context,
        artifactId(id),
        activation.version,
      );
    },
  };
}
