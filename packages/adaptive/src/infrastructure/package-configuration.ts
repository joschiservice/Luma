import {
  adaptiveViewInputSchema,
  customFieldInputSchema,
  upgradeAdaptiveViewQuery,
} from '@luma/api-contract';
import { isPermission } from '@luma/identity';
import { invalid } from '@luma/platform';
import { z } from 'zod';

import type {
  OperationalPackage,
  PackageConfiguration,
} from '../domain/packages.js';

/**
 * Resolves the maintained purchasing parameters into validated definitions without customer data.
 * View queries come out in format 2.
 */
export function configurePurchasingPackage(
  definition: OperationalPackage,
  config: PackageConfiguration,
): OperationalPackage {
  const mailbox = z.string().uuid().parse(config.parameters.mailboxId);
  const hours = z
    .number()
    .int()
    .min(1)
    .max(720)
    .parse(config.parameters.nextCheckHours);
  const read = z.string().parse(config.parameters.fieldReadPermission),
    write = z.string().parse(config.parameters.fieldWritePermission);
  if (!isPermission(read) || !isPermission(write))
    throw invalid('Choose a known field permission.');
  const label = {
    en: z.string().trim().min(1).max(100).parse(config.parameters.fieldLabelEn),
    de: z.string().trim().min(1).max(100).parse(config.parameters.fieldLabelDe),
  };

  return {
    ...definition,
    fields: definition.fields.map((field) => ({
      ...field,
      definition: customFieldInputSchema.parse({
        ...field.definition,
        label,
        readPermission: read,
        writePermission: write,
      }),
    })),
    views: definition.views.map((view) => {
      const value = adaptiveViewInputSchema.parse({
        ...z.record(z.string(), z.unknown()).parse(view.definition),
        commandId: '00000000-0000-4000-8000-000000000000',
      });
      // Reviewed definitions are always format 2, whatever format a package version used.
      const query = upgradeAdaptiveViewQuery(value.query);

      return {
        ...view,
        definition: adaptiveViewInputSchema.parse({
          ...value,
          sharing: config.sharing,
          query: {
            ...query,
            actions: query.actions.map((action) => ({
              ...action,
              inputs: {
                ...action.inputs,
                connectionId: { source: 'literal', value: mailbox },
                nextCheckHours: { source: 'literal', value: hours },
              },
            })),
          },
        }),
      };
    }),
  };
}
