import { createFileRoute, notFound } from '@tanstack/react-router';
import { z } from 'zod';

import {
  SettingsPage,
  type SettingsSection,
  settingsSections,
} from '../features/settings/page';

export const Route = createFileRoute('/app/$organizationId/settings/$section')({
  staticData: {
    help: ({ section }) =>
      section === 'roles'
        ? 'roles-and-permissions'
        : section === 'security'
          ? 'account-security'
          : section === 'api-apps'
            ? 'api-apps'
            : 'workspace-settings',
  },
  validateSearch: z.object({ role: z.string().max(100).optional() }),
  beforeLoad: ({ params }) => {
    if (!settingsSections.some((item) => item.id === params.section))
      throw notFound();
  },
  component: Page,
});

function Page() {
  const { section } = Route.useParams();
  const { role } = Route.useSearch();

  return (
    <SettingsPage
      key={section}
      section={section as SettingsSection}
      roleId={section === 'roles' ? role : undefined}
    />
  );
}
