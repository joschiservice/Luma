/** Record kinds whose identity may be established by a configured connection-pair rule. */
type AutoLinkKind = 'sku' | 'order';

export interface AutoLinkPair {
  kind: AutoLinkKind;
  targetConnectionId: string;
  sourceConnectionId: string;
}

export interface AutoLinkInput extends AutoLinkPair {
  id: string;
  /** Zero creates a rule; subsequent saves require its current revision. */
  revision: number;
  enabled: boolean;
}

export interface AutoLinkRule extends AutoLinkInput {
  principalId: string;
  state: 'disabled' | 'waiting' | 'active' | 'blocked' | 'failed';
  message: string | null;
  lastCheckedAt: string | null;
  linked: number;
}

export type AutoLinkDisposition =
  'eligible' | 'ambiguous' | 'conflict' | 'excluded' | 'stale';

interface AutoLinkCandidate {
  key: string;
  targetId: string;
  sourceId: string;
  disposition: AutoLinkDisposition;
}

export interface AutoLinkPreview {
  ready: boolean;
  message: string | null;
  counts: Record<AutoLinkDisposition, number>;
  /** At most 20 examples. Eligible matches appear first. */
  candidates: AutoLinkCandidate[];
}

/** Evidence must have been refreshed within a day; each transaction applies at most 20 links. */
export const autoLinkPolicy = {
  freshnessMs: 86_400_000,
  batchSize: 20,
  intervalMs: 60_000,
};

/** Resolves competing signals conservatively; a manual separation always wins. */
export function autoLinkDisposition(facts: {
  excluded: boolean;
  ambiguous: boolean;
  conflict: boolean;
  stale: boolean;
}): AutoLinkDisposition {
  if (facts.excluded) return 'excluded';
  if (facts.ambiguous) return 'ambiguous';
  if (facts.conflict) return 'conflict';
  if (facts.stale) return 'stale';

  return 'eligible';
}

/** Chooses a bounded batch whose identities cannot invalidate another match in the same transaction. */
export function autoLinkBatch(preview: AutoLinkPreview) {
  const used = new Set<string>();

  return preview.candidates
    .filter((candidate) => {
      if (
        candidate.disposition !== 'eligible' ||
        used.has(candidate.targetId) ||
        used.has(candidate.sourceId)
      )
        return false;
      used.add(candidate.targetId);
      used.add(candidate.sourceId);

      return true;
    })
    .slice(0, autoLinkPolicy.batchSize);
}

/** Names the rule and revision in immutable mapping evidence. */
export function autoLinkEvidence(rule: AutoLinkRule, key: string) {
  return {
    method: `Automatically linked by rule ${rule.id}, revision ${rule.revision}`,
    reason:
      `Automatic ${rule.kind === 'sku' ? 'SKU code' : 'ERP order reference'} match “${key}” under rule ${rule.id}, revision ${rule.revision}`.slice(
        0,
        2000,
      ),
  };
}

/** Chooses defaults only when one store identifies the marketplace; multiple stores need an explicit pair. */
export function defaultAutoLinkPairs(
  connections: {
    id: string;
    provider: string;
    status: string;
    granted: string[];
  }[],
): AutoLinkPair[] {
  const stores = connections.filter(
    (connection) =>
      connection.provider === 'shopify' && connection.status === 'active',
  );
  if (stores.length !== 1) return [];
  const store = stores[0]!;

  return connections.flatMap((source): AutoLinkPair[] => {
    if (source.status !== 'active' || source.id === store.id) return [];
    const kinds: AutoLinkPair['kind'][] = [];
    if (
      ['jtl', 'cin7'].includes(source.provider) &&
      store.granted.includes('products.read') &&
      source.granted.includes('products.read')
    )
      kinds.push('sku');
    if (
      ['jtl', 'cin7', 'starshipit'].includes(source.provider) &&
      store.granted.includes('orders.read') &&
      source.granted.includes('orders.read')
    )
      kinds.push('order');

    return kinds.map((kind) => ({
      kind,
      targetConnectionId: store.id,
      sourceConnectionId: source.id,
    }));
  });
}
