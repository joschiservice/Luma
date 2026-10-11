import { m } from '@luma/i18n/messages';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { contextOptions } from '../identity/data';
import { membersOptions } from '../settings/data';

/** A workspace member as the inbox names them. */
export interface Member {
  userId: string;
  name?: string | undefined;
  email?: string | undefined;
}

/**
 * Names a member for display: "You" for the reader, their name or email otherwise, and "Former
 * member" for IDs no longer in the workspace.
 */
export function memberName(
  id: string,
  members: readonly Member[],
  self: string | undefined,
) {
  if (id === self) return m.messaging_member_you();
  const member = members.find((entry) => entry.userId === id);

  return member?.name || member?.email || m.messaging_member_former();
}

/** Loads the workspace's members and the reader's ID for owner pickers and names. */
export function useMembers(organizationId: string) {
  const members = useQuery(membersOptions(organizationId));
  const context = useQuery(contextOptions(organizationId));
  const self = context.data?.actor.id;

  return useMemo(() => {
    const list: Member[] = (members.data ?? []).map((member) => ({
      userId: member.userId,
      name: member.name,
      email: member.email,
    }));

    return {
      members: list,
      self,
      name: (id: string) => memberName(id, list, self),
    };
  }, [members.data, self]);
}
