import { z } from 'zod';

import {
  anyMember,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  roleHistoryEventSchema,
  roleInputSchema,
  rolesSnapshotSchema,
  workspaceRoleSchema,
} from '../roles.js';

const path = '/v1/organizations/{organizationId}/roles';
const roleParams = organizationParamsSchema.extend({
  roleId: z.string().uuid(),
});
const command = z.object({ 'x-command-id': z.string().uuid() });

export const rolesContract = {
  list: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'List workspace roles and the permissions they can grant',
      description:
        'Returns built-in and custom roles with member counts, and the permission catalog including permissions declared by installed apps. Any member can read roles.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 409, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(rolesSnapshotSchema),
  create: endpoint
    .route({
      method: 'POST',
      path,
      successStatus: 201,
      summary: 'Create a custom role',
      description:
        'Requires `roles.manage`. You can only grant permissions you hold, unless you are an owner. Reusing `x-command-id` returns the original result.',
    })
    .meta({
      access: requires('roles.manage'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        headers: command,
        body: roleInputSchema,
      }),
    )
    .output(workspaceRoleSchema),
  update: endpoint
    .route({
      method: 'PATCH',
      path: `${path}/{roleId}`,
      summary: 'Change a custom role',
      description:
        'Send the revision you last read; a newer revision returns 409. Changes apply to every member with the role on their next request. Built-in roles cannot be changed.',
    })
    .meta({
      access: requires('roles.manage'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({
        params: roleParams,
        headers: command,
        body: roleInputSchema
          .extend({ revision: z.number().int().positive() })
          .strict(),
      }),
    )
    .output(workspaceRoleSchema),
  archive: endpoint
    .route({
      method: 'POST',
      path: `${path}/{roleId}/archive`,
      summary: 'Archive a custom role',
      description:
        'Reassign every member first; a role in use returns 409. Archiving revokes pending invitations for the role.',
    })
    .meta({
      access: requires('roles.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: roleParams,
        headers: command,
        body: z.object({ revision: z.number().int().positive() }).strict(),
      }),
    )
    .output(workspaceRoleSchema),
  history: endpoint
    .route({
      method: 'GET',
      path: `${path}/{roleId}/history`,
      summary: 'Read a role’s change history',
      description:
        'Lists up to 100 recent changes to the role and its member assignments, newest first.',
    })
    .meta({
      access: requires('roles.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({ roleId: z.string() }),
      }),
    )
    .output(z.object({ items: z.array(roleHistoryEventSchema) })),
};
