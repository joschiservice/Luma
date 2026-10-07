import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  anyMember,
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  roleHistoryEventSchema,
  roleInputSchema,
  rolesSnapshotSchema,
  workspaceRoleSchema,
} from '../roles.js';

const c = initContract();
const path = '/v1/organizations/:organizationId/roles';
const roleParams = organizationParamsSchema.extend({
  roleId: z.string().uuid(),
});
const command = z.object({ 'x-command-id': z.string().uuid() });

export const rolesContract = c.router(
  {
    list: {
      method: 'GET',
      path,
      pathParams: organizationParamsSchema,
      responses: { 200: rolesSnapshotSchema },
      metadata: anyMember,
      summary: 'List workspace roles and the permissions they can grant',
      description:
        'Returns built-in and custom roles with member counts, and the permission catalog including permissions declared by installed apps. Any member can read roles.',
    },
    create: {
      method: 'POST',
      path,
      pathParams: organizationParamsSchema,
      headers: command,
      body: roleInputSchema,
      responses: { 201: workspaceRoleSchema, 422: apiErrorSchema },
      metadata: requires('roles.manage'),
      summary: 'Create a custom role',
      description:
        'Requires `roles.manage`. You can only grant permissions you hold, unless you are an owner. Reusing `x-command-id` returns the original result.',
    },
    update: {
      method: 'PATCH',
      path: `${path}/:roleId`,
      pathParams: roleParams,
      headers: command,
      body: roleInputSchema
        .extend({ revision: z.number().int().positive() })
        .strict(),
      responses: { 200: workspaceRoleSchema, 422: apiErrorSchema },
      metadata: requires('roles.manage'),
      summary: 'Change a custom role',
      description:
        'Send the revision you last read; a newer revision returns 409. Changes apply to every member with the role on their next request. Built-in roles cannot be changed.',
    },
    archive: {
      method: 'POST',
      path: `${path}/:roleId/archive`,
      pathParams: roleParams,
      headers: command,
      body: z.object({ revision: z.number().int().positive() }).strict(),
      responses: { 200: workspaceRoleSchema },
      metadata: requires('roles.manage'),
      summary: 'Archive a custom role',
      description:
        'Reassign every member first; a role in use returns 409. Archiving revokes pending invitations for the role.',
    },
    history: {
      method: 'GET',
      path: `${path}/:roleId/history`,
      pathParams: organizationParamsSchema.extend({ roleId: z.string() }),
      responses: { 200: z.object({ items: z.array(roleHistoryEventSchema) }) },
      metadata: requires('roles.manage'),
      summary: 'Read a role’s change history',
      description:
        'Lists up to 100 recent changes to the role and its member assignments, newest first.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
