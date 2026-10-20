import { writeFile } from 'node:fs/promises';

import { openApiDocument, publicOpenApiDocument } from './openapi.js';

for (const [file, document] of [
  ['../openapi.json', openApiDocument],
  ['../openapi.public.json', publicOpenApiDocument],
] as const)
  await writeFile(
    new URL(file, import.meta.url),
    `${JSON.stringify(document, null, 2)}\n`,
  );
