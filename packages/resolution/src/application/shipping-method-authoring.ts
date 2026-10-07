import type { PlaybookGrantReader } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import type {
  PlaybookLibrary,
  PlaybookValue,
  TemplateRequirement,
  TemplateSource,
  VocabularyContribution,
} from '@luma/workflows';
import {
  connectionBlockers,
  processDraftFromPlaybook,
  templateReadiness,
} from '@luma/workflows';

import { shippingMethodPlaybook } from '../domain/shipping-method-playbook.js';

const outsideResolution =
  'Shipping-method corrections run only in the built-in Resolution workflow for detected issues.';

/** Describes the shipping-method correction's action and result check for workflow authors. */
export const shippingMethodVocabulary = {
  async vocabulary(): Promise<VocabularyContribution> {
    const { ir } = shippingMethodPlaybook;
    const types = (items: Record<string, PlaybookValue>) =>
      Object.fromEntries(
        Object.entries(items).flatMap(([name, value]) => {
          const type =
            value.source === 'literal'
              ? value.value === null
                ? 'null'
                : typeof value.value
              : (value.source === 'input' ? ir.inputs : ir.evidence.fields)[
                  value.field
                ];

          return type
            ? [[name, type as 'string' | 'number' | 'boolean' | 'null']]
            : [];
        }),
      );
    const unavailable = { executable: false, reason: outsideResolution };
    const postcondition = types(ir.action.expectedPostcondition);

    return {
      subjects: [
        {
          kind: ir.action.targetKind,
          label: 'Order',
          description: 'A sales order in a connected shop or ERP.',
          ...unavailable,
        },
      ],
      capabilities: [
        {
          capability: ir.action.capability,
          version: ir.action.capabilityVersion,
          label: 'Correct the order’s shipping method',
          description:
            'Changes the order’s shipping method in the connected system to the mapped method.',
          targetKind: ir.action.targetKind,
          minimumRisk: ir.action.minimumRisk,
          approval:
            ir.approval.mode === 'required'
              ? 'Someone else who can approve changes must approve each change.'
              : 'Workspace policy decides whether a person must approve each change.',
          parameters: types(ir.action.parameters),
          postcondition,
          evaluators: [ir.verification.evaluatorVersion],
          ...unavailable,
        },
      ],
      evaluators: [
        {
          version: ir.verification.evaluatorVersion,
          label: 'Check the shipping method',
          description:
            'Reads the order again to confirm the selected shipping method.',
          fields: postcondition,
          ...unavailable,
        },
      ],
    };
  },
};

/** Offers the shipping-method correction as a template with the connection it needs. */
export function createShippingMethodTemplate(deps: {
  digest: string;
  grants: PlaybookGrantReader;
  library: Pick<PlaybookLibrary, 'list'>;
  publish(context: TenantContext): Promise<void>;
}): TemplateSource {
  const { definition, version } = shippingMethodPlaybook;

  return {
    id: definition.id,
    async template(context) {
      const [sources, published] = await Promise.all([
        deps.grants(context, false),
        deps.library.list(context),
      ]);
      const summary = published.find((item) => item.id === definition.id);
      const blockers = sources.map((source) => connectionBlockers(source));
      const eligible = blockers.some((items) => items.length === 0);
      const requirements: TemplateRequirement[] = [
        {
          label: 'A connection that can change shipping methods',
          met: eligible,
          detail: eligible
            ? 'A connection grants shipping-method changes and has mapped orders.'
            : (blockers[0]?.[0] ??
              'Connect a shop or ERP that grants orders.shipping-method.write and orders.read.'),
          fix: eligible
            ? null
            : { label: 'Open Connections', destination: 'connections' },
        },
      ];

      return {
        id: definition.id,
        name: definition.name,
        purpose: definition.intent,
        category: 'resolution',
        trigger: 'When Luma detects an order stuck on a wrong shipping method',
        steps: [
          'Check that the diagnosis is ready and the method is mapped',
          'Propose the mapped shipping method for the order',
          'Ask someone else who can approve changes to approve the change',
          'Read the order again to confirm the new method',
        ],
        success:
          'An independent read shows the mapped shipping method on the order. Fulfillment needs separate evidence.',
        requirements,
        readiness: templateReadiness(requirements),
        status: summary?.status ?? 'inactive',
        configure: 'resolution',
        installed: !!summary,
        version,
        digest: deps.digest,
      };
    },
    content: () =>
      processDraftFromPlaybook(shippingMethodPlaybook, 'resolution'),
    install: (context) => deps.publish(context),
  };
}
