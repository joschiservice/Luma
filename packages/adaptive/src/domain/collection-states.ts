/** A list page's identifier, such as `orders`; validated against the list catalog. */
export type CollectionStateDomain = string;

/**
 * A member's validated list state. Its shape belongs to the API contract; this module only
 * stores and returns it whole.
 */
export type CollectionMemberStateDocument = Record<string, unknown>;

export interface StoredCollectionState {
  state: CollectionMemberStateDocument;
  sequence: number;
  updatedAt: string;
}

export interface CollectionStateResponse {
  domain: CollectionStateDomain;
  state: CollectionMemberStateDocument | null;
  sequence: number;
  updatedAt: string | null;
}
