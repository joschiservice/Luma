import {
  collectionDomainSchema,
  collectionMemberStateSchema,
  collectionPermissions,
} from '@luma/api-contract';
import { invalid, notFound } from '@luma/platform';

import type { CollectionMemberStateDocument } from '../domain/collection-states.js';

/** Validates list identifiers and member state against the shared list contract. */
export const collectionsValidation = {
  domain(value: unknown) {
    const parsed = collectionDomainSchema.safeParse(value);
    if (!parsed.success) throw notFound('List not found.');

    return parsed.data;
  },
  state(value: unknown): CollectionMemberStateDocument {
    const parsed = collectionMemberStateSchema.safeParse(value);
    if (!parsed.success) throw invalid('The list state is not valid.');

    return parsed.data;
  },
  permission(domain: string) {
    const parsed = collectionDomainSchema.safeParse(domain);

    return parsed.success ? collectionPermissions[parsed.data] : null;
  },
};
