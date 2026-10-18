import './exceptions.css';

import type { CaseDetail } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  type PersonOption,
  PersonPicker,
} from '@luma/ui/components/primitives/person-picker';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleUserRound } from 'lucide-react';

import { usePermissions } from '../../kit/identity/permissions';
import { membersOptions } from '../../kit/settings/data';
import { createWebApiClient } from '../../lib/api-client';

const api = createWebApiClient();

/**
 * Shows the issue owner as a compact header property. Without `people` the owner is read-only;
 * with them, the property opens a picker that assigns someone else or, when `onClear` is set,
 * removes the owner. `errors` are announced beneath the property.
 */
export function CaseOwnerProperty({
  name,
  people,
  onSelect,
  onClear,
  disabled = false,
  errors = [],
}: {
  /** The owner's name, or undefined when nobody owns the issue. */
  name: string | undefined;
  people?: readonly PersonOption[] | undefined;
  onSelect?: (id: string) => void;
  onClear?: (() => void) | undefined;
  disabled?: boolean;
  errors?: readonly string[];
}) {
  const shown = name ?? m.exceptions_owner_none();
  const display = (
    <>
      <CircleUserRound aria-hidden="true" />
      <span className="case-owner-name">{shown}</span>
    </>
  );

  return (
    <span className="case-owner" data-assigned={name ? true : undefined}>
      {people ? (
        <PersonPicker
          variant="ghost"
          className="case-owner-trigger"
          label={m.exceptions_owner_change({ owner: shown })}
          title={m.exceptions_owner_picker_title()}
          people={people}
          onSelect={(id) => onSelect?.(id)}
          clear={
            onClear ? { label: m.exceptions_owner_clear(), onClear } : undefined
          }
          disabled={disabled}
        >
          {display}
        </PersonPicker>
      ) : (
        <span className="case-owner-value">
          <span className="sr-only">{m.exceptions_owner_label()}: </span>
          {display}
        </span>
      )}
      {errors.map((error) => (
        <span className="case-owner-error" role="alert" key={error}>
          {error}
        </span>
      ))}
    </span>
  );
}

/**
 * Loads assignable members for people allowed to assign and saves owner changes with the
 * issue's owner revision, so a concurrent reassignment is rejected instead of overwritten.
 * `onChange` refreshes the issue after a change is saved.
 */
export function CaseOwnerControl({
  organizationId,
  item,
  onChange,
}: {
  organizationId: string;
  item: CaseDetail;
  onChange: () => Promise<void>;
}) {
  const permissions = usePermissions(organizationId);
  const manage = permissions.can('decisions.assign');
  const members = useQuery({
    ...membersOptions(organizationId),
    enabled: manage,
  });
  const assign = useMutation({
    mutationFn: (userId: string | null) =>
      api.exceptions.assignOwner({
        params: { organizationId, exceptionId: item.id },
        body: { userId, revision: item.owner?.revision ?? 0 },
      }),
    onSuccess: onChange,
  });
  const ownerId = item.owner?.userId;

  return (
    <CaseOwnerProperty
      name={
        ownerId
          ? (item.owner?.name ?? m.decisions_member_fallback())
          : undefined
      }
      people={
        manage
          ? (members.data ?? [])
              .filter(
                (member) =>
                  member.status === 'active' && member.userId !== ownerId,
              )
              .map((member) => ({
                id: member.userId,
                name:
                  member.name || member.email || m.decisions_member_fallback(),
                detail: member.email,
              }))
          : undefined
      }
      onSelect={(id) => assign.mutate(id)}
      onClear={ownerId ? () => assign.mutate(null) : undefined}
      disabled={assign.isPending || !members.data}
      errors={[
        ...(assign.isError ? [assign.error.message] : []),
        ...(manage && members.isError
          ? [m.exceptions_owner_members_failed()]
          : []),
      ]}
    />
  );
}
