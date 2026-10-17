import type { CapabilityReader } from '@luma/connections';
import type { AttachmentReader, DocumentDirectory } from '@luma/messaging';
import type { TenantDatabase } from '@luma/platform';
import { createMessageDocumentDirectory } from '@luma/read-models/composition';

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
  return createMessageDocumentDirectory(database);
}
