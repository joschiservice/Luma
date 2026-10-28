import { createFileRoute } from '@tanstack/react-router';

import { AcceptInvitation } from '../features/settings/invitation';

export const Route = createFileRoute(
  '/app/invitations/$organizationId/$invitationId',
)({ ssr: false, component: AcceptInvitation });
