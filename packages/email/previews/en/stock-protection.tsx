import { EmailPreview } from '../_shared/preview.js';

/** Previews a stock-protection incident notification. */
export default function StockProtectionAlert() {
  return <EmailPreview kind="stock_protection" locale="en" />;
}
