import type { RunDetail } from '@luma/simulator-contract';

import { MerchantActions } from './merchant-actions';
import { RecordBrowser } from './records';
import { SkuLookup } from './sku-lookup';

/** Provider state: stored records, stock by SKU and merchant actions. */
export function ProvidersView({ run }: { run: RunDetail }) {
  return (
    <div className="sim-stack">
      <h2 className="sim-section-title">Providers</h2>
      <SkuLookup run={run} />
      <RecordBrowser run={run} />
      <MerchantActions run={run} />
    </div>
  );
}
