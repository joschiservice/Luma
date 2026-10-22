import {
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  Kind,
  parse,
  type SelectionSetNode,
} from 'graphql';

/** Shopify's single-query limit; it also bounds the cost admission reserves for one request. */
export const maxQueryCost = 1000;

/** Bounds parsed documents kept per process; Luma's own document shapes stay well below it. */
const cachedDocuments = 500;
const documents = new Map<string, DocumentNode | null>();

/**
 * Calculates the cost Shopify will request for a GraphQL document before it is sent, using
 * Shopify's published rules: scalars and enums are free, each object costs one, a connection
 * costs two plus its page size times the cost of each node, a list sized by `first` costs per
 * item, inline fragments on different types cost their most expensive branch and each
 * top-level mutation field costs ten. Page sizes come from literal arguments or `variables`.
 * The result is clamped to Shopify's 1,000-point single-query limit, which Shopify enforces
 * by rejecting the query. Returns undefined when the document cannot be parsed or does not
 * contain exactly one query or mutation; admission then assumes the single-query maximum.
 * Admission prefers the cost Shopify reports for the same request shape once it has one.
 */
export function calculateQueryCost(
  document: string,
  variables: Record<string, unknown>,
): number | undefined {
  const parsed = parseDocument(document);
  const operations = parsed?.definitions.filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  const operation = operations?.length === 1 ? operations[0] : undefined;
  if (!parsed || !operation) return undefined;
  if (operation.operation === 'mutation')
    return Math.min(
      maxQueryCost,
      10 * operation.selectionSet.selections.length,
    );
  if (operation.operation !== 'query') return undefined;
  const fragments = new Map(
    parsed.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode =>
          definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((definition) => [definition.name.value, definition]),
  );

  const size = (field: FieldNode, names: readonly string[]) => {
    for (const name of names) {
      const value = field.arguments?.find(
        (item) => item.name.value === name,
      )?.value;
      if (value?.kind === Kind.INT) return Number(value.value);
      if (value?.kind === Kind.VARIABLE) {
        const resolved = variables[value.name.value];
        if (typeof resolved === 'number') return resolved;
      }
    }

    return undefined;
  };

  const cost = (set: SelectionSetNode | undefined): number => {
    let total = 0;
    let branches = 0;
    for (const selection of set?.selections ?? []) {
      if (selection.kind === Kind.FIELD) {
        if (!selection.selectionSet) continue;
        // A connection is recognized by its node lists; its page info is part of the two points.
        const listed = selection.selectionSet.selections.filter(
          (inner): inner is FieldNode =>
            inner.kind === Kind.FIELD &&
            ['nodes', 'edges'].includes(inner.name.value),
        );
        const page = size(selection, ['first', 'last']) ?? 1;
        if (listed.length > 0)
          total += listed.reduce(
            (sum, inner) => sum + page * (1 + cost(inner.selectionSet)),
            2,
          );
        else
          total +=
            (size(selection, ['first']) ?? 1) *
            (1 + cost(selection.selectionSet));
      } else {
        const fragment =
          selection.kind === Kind.FRAGMENT_SPREAD
            ? fragments.get(selection.name.value)
            : selection;
        const inner = cost(fragment?.selectionSet);
        if (fragment?.typeCondition) branches = Math.max(branches, inner);
        else total += inner;
      }
    }

    return total + branches;
  };

  return Math.min(maxQueryCost, Math.max(1, cost(operation.selectionSet)));
}

function parseDocument(document: string) {
  const cached = documents.get(document);
  if (cached !== undefined) return cached;
  let parsed: DocumentNode | null;
  try {
    parsed = parse(document, { noLocation: true });
  } catch {
    parsed = null;
  }
  if (documents.size >= cachedDocuments) documents.clear();
  documents.set(document, parsed);

  return parsed;
}
