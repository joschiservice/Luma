import type { CollectionCondition } from '@luma/api-contract';

/** What an owner pill can choose: the reader, nobody, or one person by user ID. */
export type OwnerChoice = 'me' | 'unassigned' | (string & {});

/** The person field a list offers as an owner pill, with the members it can choose. */
export interface OwnerFilter {
  field: string;
  members: readonly { value: string; label: string }[];
  /** Offer Unassigned: an owner condition "is empty". */
  unassigned?: boolean | undefined;
}

function isMe(value: unknown) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dynamic' in value &&
    value.dynamic === 'me'
  );
}

/**
 * The owner pill's choice that a condition expresses, or undefined when the condition is not an
 * owner pill: "is me" is `me` (resolved for each reader, so shared views follow whoever opens
 * them), "is empty" is `unassigned`, "is <person>" names that person. Other owner conditions,
 * such as several people, stay in the condition builder.
 */
export function ownerChoice(
  condition: CollectionCondition,
  owner: OwnerFilter,
): OwnerChoice | undefined {
  if (condition.field !== owner.field) return undefined;
  if (condition.op === 'empty')
    return owner.unassigned ? 'unassigned' : undefined;
  if (
    condition.op !== 'any_of' ||
    !Array.isArray(condition.value) ||
    condition.value.length !== 1
  )
    return undefined;
  const [value] = condition.value;
  if (isMe(value)) return 'me';

  return typeof value === 'string' ? value : undefined;
}

/** The condition an owner pill choice writes. */
export function ownerCondition(
  field: string,
  choice: OwnerChoice,
): CollectionCondition {
  if (choice === 'unassigned') return { field, op: 'empty' };

  return {
    field,
    op: 'any_of',
    value: [choice === 'me' ? { dynamic: 'me' } : choice],
  };
}
