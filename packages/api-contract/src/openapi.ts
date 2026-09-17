import { generateOpenApi } from '@ts-rest/open-api';
import { apiContract } from './index.js';

export const openApiDocument = generateOpenApi(
  apiContract,
  {
    info: {
      title: 'Luma API',
      version: '1.0.0',
      description:
        'Manage your organizations and memberships, resolve organization access, browse connector providers and check service availability. Organization endpoints require a session cookie.',
    },
  },
  { setOperationId: 'concatenated-path' },
);
