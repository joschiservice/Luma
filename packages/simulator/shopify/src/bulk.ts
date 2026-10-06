import type {
  ProviderRequest,
  ProviderResponse,
  StoredRecord,
} from '@luma/simulator-core';
import { execute, GraphQLError } from 'graphql';

import type { RequestContext } from './context.js';
import { createLoader } from './context.js';
import { prepare } from './operation.js';
import { all, gid, parseGid, type ShopifyContext } from './records.js';
import { fieldResolver, typeResolver } from './resolvers.js';
import { schema } from './schema.js';

interface BulkData {
  query: string;
  status: string;
  readyAt: number;
  file: string;
  rootObjectCount: string;
}

const view = (context: RequestContext, item: StoredRecord<BulkData>) => ({
  id: gid('BulkOperation', item.id),
  query: item.data.query,
  status:
    context.shop.wallTime >= item.data.readyAt && item.data.status === 'RUNNING'
      ? 'COMPLETED'
      : item.data.status,
  url: `https://storage.googleapis.com/luma-bulk/${item.id}`,
  rootObjectCount: item.data.rootObjectCount,
});

/** Executes simulator bulk queries and exposes persisted operations through the Admin API. */
export const bulkResolver: typeof fieldResolver = async (
  source,
  args,
  context,
  info,
) => {
  if (
    info.parentType.name === 'QueryRoot' &&
    info.fieldName === 'bulkOperation'
  ) {
    const parsed = parseGid(args.id);
    const record =
      parsed &&
      (await context.shop.store.get<BulkData>('BulkOperation', parsed.id));

    return record ? view(context, record) : null;
  }
  if (
    info.parentType.name === 'QueryRoot' &&
    info.fieldName === 'bulkOperations'
  ) {
    const page = await context.shop.store.page<BulkData>({
      kind: 'BulkOperation',
      limit: Number(args.first ?? 100),
      after: args.after ?? null,
    });

    return {
      nodes: page.items.map((item) => view(context, item)),
      pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
    };
  }
  if (
    info.parentType.name === 'Mutation' &&
    info.fieldName === 'bulkOperationRunQuery'
  ) {
    const operations = await all<BulkData>(context.shop, {
      kind: 'BulkOperation',
    });
    if (
      operations.filter((item) =>
        ['RUNNING', 'CREATED'].includes(view(context, item).status),
      ).length >= 5
    )
      return {
        bulkOperation: null,
        userErrors: [
          {
            field: ['query'],
            message: 'All five bulk query slots are occupied.',
          },
        ],
      };
    const query: unknown = args.query;
    if (typeof query !== 'string') throw new GraphQLError('Invalid bulk query');
    const prepared = prepare(query);
    if (!prepared.document || prepared.errors.length)
      return {
        bulkOperation: null,
        userErrors: [{ field: ['query'], message: 'Invalid bulk query.' }],
      };
    const result = await execute({
      schema,
      document: prepared.document,
      contextValue: {
        ...context,
        bulk: true,
        loader: createLoader(context.shop.store),
      },
      fieldResolver,
      typeResolver,
    });
    if (result.errors || !result.data)
      return {
        bulkOperation: null,
        userErrors: [
          {
            field: ['query'],
            message: 'Bulk query could not read the requested data.',
          },
        ],
      };
    const lines: string[] = [];
    let roots = 0;

    function flatten(node: Record<string, unknown>, parent?: string) {
      const scalar: Record<string, unknown> = {};
      const children: Record<string, unknown>[] = [];
      for (const [key, value] of Object.entries(node)) {
        if (
          value &&
          typeof value === 'object' &&
          'edges' in value &&
          Array.isArray(value.edges)
        )
          for (const edge of value.edges) {
            if (
              edge &&
              typeof edge === 'object' &&
              'node' in edge &&
              edge.node &&
              typeof edge.node === 'object'
            )
              children.push(edge.node as Record<string, unknown>);
          }
        else scalar[key] = value;
      }
      if (parent) scalar.__parentId = parent;
      lines.push(JSON.stringify(scalar));
      for (const child of children) flatten(child, String(node.id));
    }

    for (const value of Object.values(result.data)) {
      if (
        !value ||
        typeof value !== 'object' ||
        !('edges' in value) ||
        !Array.isArray(value.edges)
      )
        throw new GraphQLError('A bulk query requires a connection.');
      for (const edge of value.edges) {
        flatten(edge.node);
        roots++;
      }
    }
    const id = String(await context.shop.store.sequence('bulk'));
    const data: BulkData = {
      query,
      status: 'RUNNING',
      readyAt: context.shop.wallTime + 1000,
      file: lines.length ? `${lines.join('\n')}\n` : '',
      rootObjectCount: String(roots),
    };
    await context.shop.store.put('BulkOperation', id, data, {
      createdAt: context.shop.wallTime,
    });
    context.committed = true;

    return {
      bulkOperation: view(
        context,
        (await context.shop.store.get<BulkData>('BulkOperation', id))!,
      ),
      userErrors: [],
    };
  }

  return fieldResolver(source, args, context, info);
};

/** Serves a signed synthetic JSONL export, including Range reads and seven-day expiry. */
export async function bulkDownload(
  context: ShopifyContext,
  request: ProviderRequest,
): Promise<ProviderResponse | null> {
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.hostname !== 'storage.googleapis.com' ||
    !url.pathname.startsWith('/luma-bulk/')
  )
    return null;
  const id = url.pathname.slice('/luma-bulk/'.length);
  const item = await context.store.get<BulkData>('BulkOperation', id);
  if (
    !item ||
    context.wallTime - item.createdAt > 7 * 86_400_000 ||
    (item.data.status !== 'RUNNING' && item.data.status !== 'COMPLETED')
  )
    return { status: 403, headers: {}, body: null };
  const bytes = Buffer.from(item.data.file);
  const offset = Number(
    /^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0,
  );

  return {
    status: offset ? 206 : 200,
    headers: {
      'content-type': 'application/jsonl',
      ...(offset
        ? {
            'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
          }
        : {}),
    },
    body: null,
    bodyText: bytes.subarray(offset).toString('utf8'),
  };
}
