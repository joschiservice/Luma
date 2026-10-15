import type { CaseDetail } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { PersonPicker } from '@luma/ui/components/primitives/person-picker';
import { useMutation, useQuery } from '@tanstack/react-query';

import { usePermissions } from '../../kit/identity/permissions';
import { membersOptions } from '../../kit/settings/data';
import { createWebApiClient } from '../../lib/api-client';

const api = createWebApiClient();

/** Shows case responsibility and uses optimistic revisions to prevent lost reassignments. */
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

  return (
    <Card as="section" aria-label={m.authoring_coordination_owner()}>
      <CardHeader>
        <CardTitle as="h2">{m.authoring_coordination_owner()}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="case-owner-controls">
          <p>
            {item.owner?.name ??
              (item.owner?.userId
                ? m.decisions_member_fallback()
                : m.authoring_coordination_unassigned())}
          </p>
          {manage ? (
            <PersonPicker
              label={m.authoring_coordination_assignee()}
              title={m.authoring_coordination_owner()}
              people={(members.data ?? [])
                .filter((member) => member.status === 'active')
                .map((member) => ({
                  id: member.userId,
                  name:
                    member.name ||
                    member.email ||
                    m.decisions_member_fallback(),
                  detail: member.email,
                }))}
              onSelect={(id) => assign.mutate(id)}
              disabled={assign.isPending || !members.data}
            />
          ) : null}
          {manage && item.owner?.userId ? (
            <Button
              variant="ghost"
              onClick={() => assign.mutate(null)}
              disabled={assign.isPending}
            >
              {m.authoring_coordination_clear()}
            </Button>
          ) : null}
          {assign.isError ? <p role="alert">{assign.error.message}</p> : null}
          {manage && members.isError ? (
            <p role="alert">{m.authoring_coordination_unavailable()}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
