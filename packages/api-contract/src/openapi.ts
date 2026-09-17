import { generateOpenApi } from '@ts-rest/open-api';
import { apiContract } from './index.js';

export const openApiDocument = generateOpenApi(
  apiContract,
  {
    info: {
      title: 'Luma API',
      version: '1.0.0',
      description:
        'Browse the connector provider catalog and check Luma service availability. These endpoints are public and return JSON.',
    },
  },
  { setOperationId: 'concatenated-path' },
);
