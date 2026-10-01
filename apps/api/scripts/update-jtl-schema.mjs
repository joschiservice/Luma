import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const sourceUrl = 'https://developer.jtl-software.com/openapi/erp/2.2.json';

// An optional local file argument pins a schema already downloaded from sourceUrl.
async function download() {
  if (process.argv[2]) return readFile(process.argv[2], 'utf8');
  const response = await fetch(sourceUrl);
  if (!response.ok)
    throw new Error(`Schema download failed: ${response.status}`);

  return response.text();
}

const source = await download();

const api = JSON.parse(source);

const schemas = {};

// Preserve structural constraints; omit prose and examples from the offline contract.
const keywords = new Set([
  'type',
  'format',
  'required',
  'properties',
  'items',
  'enum',
  'nullable',
  'additionalProperties',
  '$ref',
  'allOf',
  'oneOf',
  'anyOf',
]);

function schema(value) {
  if (Array.isArray(value)) return value.map(schema);
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const name = value.$ref.split('/').at(-1);
    if (!Object.hasOwn(schemas, name)) {
      schemas[name] = {};
      schemas[name] = schema(api.components.schemas[name]);
    }
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => keywords.has(key))
      .map(([key, value]) => [
        key,
        key === 'properties'
          ? Object.fromEntries(
              Object.entries(value).map(([key, value]) => [key, schema(value)]),
            )
          : schema(value),
      ]),
  );
}

const paths = {};

for (const path of [
  '/v2/sales-orders',
  '/v2/sales-orders/{salesOrderId}/line-items',
  '/v2/items',
  '/v2/warehouses/{warehouseId}/items/{itemId}/stocks',
  '/v2/delivery-notes',
  '/v2/delivery-notes/{deliveryNoteId}',
  '/v2/delivery-notes/{deliveryNoteId}/line-items',
  '/v2/sales-orders/{salesOrderId}',
  '/v2/suppliers',
  '/v2/suppliers/{supplierId}',
  '/v2/items/{itemId}/suppliers',
  '/v2/purchase-orders',
  '/v2/purchase-orders/{purchaseOrderId}',
]) {
  const get = api.paths[path].get;
  paths[path] = {
    parameters: get.parameters.map(({ name, in: location }) => ({
      name,
      in: location,
    })),
    // OAuth scopes the endpoint requires; installation probes grant capabilities from them.
    scopes: [
      ...new Set(
        (get.security ?? []).flatMap((entry) => Object.values(entry).flat()),
      ),
    ],
    response: schema(get.responses['200'].content['application/json'].schema),
  };
}

const patch = api.paths['/v2/sales-orders/{salesOrderId}'].patch;

const shippingMethodWrite = {
  parameters: patch.parameters.map(({ name, in: location }) => ({
    name,
    in: location,
  })),
  request: schema(patch.requestBody.content['application/json'].schema),
  response: schema(patch.responses['200'].content['application/json'].schema),
};

const post = api.paths['/v2/purchase-orders'].post;

const purchaseOrderCreate = {
  parameters: post.parameters.map(({ name, in: location }) => ({
    name,
    in: location,
  })),
  scopes: [
    ...new Set(
      (post.security ?? []).flatMap((entry) => Object.values(entry).flat()),
    ),
  ],
  request: schema(post.requestBody.content['application/json'].schema),
  response: schema(post.responses['201'].content['application/json'].schema),
};

await writeFile(
  new URL(
    '../../../packages/apps/jtl/src/infrastructure/fixtures/erp-2.2.json',
    import.meta.url,
  ),
  JSON.stringify(
    {
      sourceUrl,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      version: api.info.version,
      paths,
      shippingMethodWrite,
      purchaseOrderCreate,
      schemas,
    },
    null,
    2,
  ) + '\n',
);
