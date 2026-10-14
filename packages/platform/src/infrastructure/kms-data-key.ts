import { z } from 'zod';

import { type AwsCredentials, signAwsRequest } from './aws-signature.js';

const base64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

/** Calls the configured regional KMS endpoint, with bounded requests and no endpoint fallback. */
export function createKmsDataKeyService(
  settings: { kmsRegion: string; credentials: AwsCredentials },
  context: { region: string; namespace: string },
  transport: typeof fetch = fetch,
): {
  generate(
    keyArn: string,
  ): Promise<{ plaintext: Uint8Array; wrappedKey: Uint8Array }>;
  decrypt(keyArn: string, wrappedKey: Uint8Array): Promise<Uint8Array>;
} {
  const url = new URL(`https://kms.${settings.kmsRegion}.amazonaws.com/`);

  async function call(operation: string, input: Record<string, unknown>) {
    const body = JSON.stringify({
      ...input,
      EncryptionContext: { application: 'luma-temporal-v1', ...context },
    });
    const headers = signAwsRequest({
      method: 'POST',
      url,
      body,
      service: 'kms',
      region: settings.kmsRegion,
      credentials: settings.credentials,
      date: new Date(),
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `TrentService.${operation}`,
      },
    });
    const response = await transport(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Temporal encryption key unavailable');

    return z
      .object({
        KeyId: z.string(),
        Plaintext: base64,
        CiphertextBlob: base64.optional(),
      })
      .parse(await response.json());
  }

  return {
    async generate(keyArn) {
      const value = await call('GenerateDataKey', {
        KeyId: keyArn,
        KeySpec: 'AES_256',
      });
      if (value.KeyId !== keyArn || !value.CiphertextBlob)
        throw new Error('Temporal encryption key binding rejected');

      return {
        plaintext: Buffer.from(value.Plaintext, 'base64'),
        wrappedKey: Buffer.from(value.CiphertextBlob, 'base64'),
      };
    },
    async decrypt(keyArn, wrappedKey) {
      const value = await call('Decrypt', {
        KeyId: keyArn,
        CiphertextBlob: Buffer.from(wrappedKey).toString('base64'),
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      });
      if (value.KeyId !== keyArn)
        throw new Error('Temporal encryption key binding rejected');

      return Buffer.from(value.Plaintext, 'base64');
    },
  };
}
