import { randomBytes } from 'node:crypto';

import { expect, it, vi } from 'vitest';

import { createKmsDataKeyService } from './kms-data-key.js';

const keyArn =
  'arn:aws:kms:ap-southeast-2:123456789012:key/11111111-1111-1111-1111-111111111111';
const previousArn = keyArn.replace(
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
);
const settings = {
  keyArn,
  decryptionKeyArns: [],
  kmsRegion: 'ap-southeast-2',
  credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
  cacheTtlMs: 1000,
  cacheMaxUses: 2,
};
const context = { region: 'AU', namespace: 'synthetic' };

it('binds KMS requests to namespace and region, rejects redirects and wrong keys', async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          KeyId: keyArn,
          Plaintext: randomBytes(32).toString('base64'),
          CiphertextBlob: randomBytes(48).toString('base64'),
        }),
      ),
  );
  const keys = createKmsDataKeyService(settings, context, transport);
  await keys.generate(keyArn);
  const [url, options] = transport.mock.calls[0]!;
  expect(String(url)).toBe('https://kms.ap-southeast-2.amazonaws.com/');
  expect(options?.redirect).toBe('error');
  expect(JSON.parse(options!.body as string)).toMatchObject({
    KeyId: keyArn,
    KeySpec: 'AES_256',
    EncryptionContext: { region: 'AU', namespace: 'synthetic' },
  });
  transport.mockResolvedValue(
    new Response(
      JSON.stringify({
        KeyId: previousArn,
        Plaintext: randomBytes(32).toString('base64'),
      }),
    ),
  );
  await expect(keys.decrypt(keyArn, randomBytes(48))).rejects.toThrow(
    'binding rejected',
  );
  transport.mockResolvedValue(new Response('unavailable', { status: 503 }));
  await expect(keys.generate(keyArn)).rejects.toThrow('unavailable');
});
