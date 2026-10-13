/** Supplier prices remain unknown when a provider does not expose currency or validity. */
export interface SupplierTermsValues {
  supplierArticleNumber: string | null;
  unitPrice: {
    amount: string;
    currency: string | null;
    validFrom: string | null;
  } | null;
  packSize: number | null;
  lineMinimumQuantity: number | null;
  orderMinimumValue: { amount: string; currency: string } | null;
  leadTimeDays: number | null;
  preferred: boolean | null;
}

/** @public Declaration emit names the explicitly observed or overridden fields in term versions. */
export type SupplierTermsPatch = {
  [Key in keyof SupplierTermsValues]?: SupplierTermsValues[Key] | undefined;
};

/** An immutable report or separately recorded override of purchasing terms. */
export interface SupplierTermsVersion {
  id: string;
  supplierId: string;
  skuId: string;
  revision: number;
  source: 'provider' | 'manual' | 'import';
  values: SupplierTermsPatch;
  recordedAt: string;
  observedAt: string;
  actorId: string;
  reason: string;
  connectionId: string | null;
  sourceRecordId: string | null;
  sourceUpdatedAt: string | null;
  complete: boolean;
}

export interface SupplierProductTerms {
  supplierId: string;
  supplierName: string;
  skuId: string;
  sku: string;
  revision: number;
  lastReadAt?: string | undefined;
  lastReadComplete?: boolean | undefined;
  effective: SupplierTermsValues;
  observed: SupplierTermsVersion | null;
  override: SupplierTermsVersion | null;
  history: SupplierTermsVersion[];
}

export interface SupplierTermsInput {
  id: string;
  supplierId: string;
  skuId: string;
  expectedRevision: number;
  reason: string;
  values: SupplierTermsPatch;
}

/** Resolves observed values and a separate human override without supplying missing defaults. */
export function effectiveSupplierTerms(
  history: SupplierTermsVersion[],
  asOf: string,
): {
  effective: SupplierTermsValues;
  observed: SupplierTermsVersion | null;
  override: SupplierTermsVersion | null;
} {
  const observed = history.filter((v) => v.source !== 'manual').at(-1) ?? null;
  const overrides = history.filter((v) => v.source === 'manual');
  const override = overrides.at(-1) ?? null;
  const empty: SupplierTermsValues = {
    supplierArticleNumber: null,
    unitPrice: null,
    packSize: null,
    lineMinimumQuantity: null,
    orderMinimumValue: null,
    leadTimeDays: null,
    preferred: null,
  };
  // Partial reports carry forward fields they did not read; explicit null remains missing.
  const reports = history.filter((v) => v.source !== 'manual');

  const usable = (version: SupplierTermsVersion) => {
    const values = { ...version.values };
    if (values.unitPrice?.validFrom && values.unitPrice.validFrom > asOf)
      delete values.unitPrice;

    return values;
  };

  return {
    effective: Object.assign(
      empty,
      ...reports.map(usable),
      ...overrides.map(usable),
    ),
    observed,
    override,
  };
}
