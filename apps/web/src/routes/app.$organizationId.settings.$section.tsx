import { createFileRoute, notFound } from '@tanstack/react-router';

import {
  SettingsPage,
  type SettingsSection,
  settingsSections,
} from '../features/settings/page';

export const Route = createFileRoute('/app/$organizationId/settings/$section')({
  beforeLoad: ({ params }) => {
    if (!settingsSections.some((item) => item.id === params.section))
      throw notFound();
  },
  component: Page,
});

function Page() {
  const { section } = Route.useParams();

  return <SettingsPage key={section} section={section as SettingsSection} />;
}
