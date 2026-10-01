import { createFileRoute } from '@tanstack/react-router';

import {
  parseProcurementSearch,
  ProcurementPage,
} from '../features/procurement/page';

export const Route = createFileRoute('/app/$organizationId/procurement/')({
  validateSearch: parseProcurementSearch,
  staticData: { help: 'procurement' },
  component: ProcurementPage,
});
