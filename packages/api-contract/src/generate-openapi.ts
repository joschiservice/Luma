import { writeFile } from 'node:fs/promises';

import { openApiDocument } from './openapi.js';

await writeFile(
  new URL('../openapi.json', import.meta.url),
  `${JSON.stringify(openApiDocument, null, 2)}\n`,
);
