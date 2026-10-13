import {
  adaptiveViewInputSchema,
  customFieldInputSchema,
} from '@luma/api-contract';
import { IdentityError, isPermission } from '@luma/identity';
import { z } from 'zod';

import type {
  OperationalPackage,
  PackageConfiguration,
} from '../domain/packages.js';

/** Resolves the maintained purchasing parameters into validated definitions without customer data. */
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
    throw new IdentityError(
      422,
      'VALIDATION_ERROR',
      'Choose a known field permission.',
    );
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

      return {
        ...view,
        definition: adaptiveViewInputSchema.parse({
          ...value,
          sharing: config.sharing,
          query: {
            ...value.query,
            actions: value.query.actions.map((action) => ({
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
