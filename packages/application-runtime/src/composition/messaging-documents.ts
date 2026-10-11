import type { CapabilityReader } from '@luma/connections';
import type { AttachmentReader, DocumentDirectory } from '@luma/messaging';
import type { TenantDatabase } from '@luma/platform';

/**
 * Reads attachment content through the installation-gated capability runtime. Content arrives
 * as base64 and is decoded here; the provider's digest is passed on to be checked.
 */
export function createAttachmentReader(
  runtime: CapabilityReader,
): AttachmentReader {
  return {
    async read(context, connectionId, input) {
      const result = await runtime.read(context, {
        connectionId,
        capability: 'message-attachments.read',
        version: '0',
        input,
      });
      if (!result.ok) return { ok: false, code: result.error.code };

      return {
        ok: true,
        bytes: new Uint8Array(Buffer.from(result.value.base64, 'base64')),
        sha256: result.value.sha256 || null,
      };
    },
  };
}

/**
 * Deliberate cross-owner reads for matching document facts: catalog SKU codes and supplier
 * names. Exact matches only, after trimming and case folding.
 */
export function createDocumentDirectory(
  database: TenantDatabase,
): DocumentDirectory {
  return {
    async skus(context, codes) {
      return database.transaction(
        context.tenantId,
        async (tx) =>
          new Set(
            (
              await tx.query<{ code: string }>(
                `SELECT DISTINCT upper(btrim(code)) AS code FROM inventory_product_skus
                WHERE tenant_id=$1 AND code_key=ANY($2::text[])`,
                [context.tenantId, codes.map((code) => code.toLowerCase())],
              )
            ).rows.map((row) => row.code),
          ),
      );
    },
    async suppliers(context, names) {
      return database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ id: string; key: string }>(
              `SELECT id,lower(btrim(document->>'name')) AS key FROM procurement_suppliers
              WHERE tenant_id=$1 AND lower(btrim(document->>'name'))=ANY($2::text[])`,
              [context.tenantId, names],
            )
          ).rows,
      );
    },
  };
}
