import { randomBytes } from 'node:crypto';

import { defaultPayloadConverter } from '@temporalio/common';
import { describe, expect, it, vi } from 'vitest';

import {
  createTemporalPayloadCodec,
  type TemporalKeyService,
  type TemporalPayloadEncryption,
} from './payload-codec.js';
import { temporalActivities } from './runtime.js';

const keyArn =
  'arn:aws:kms:ap-southeast-2:123456789012:key/11111111-1111-1111-1111-111111111111';
const previousArn = keyArn.replace(
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
);
const settings: TemporalPayloadEncryption = {
  keyArn,
  decryptionKeyArns: [],
  kmsRegion: 'ap-southeast-2',
  credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
  cacheTtlMs: 1000,
  cacheMaxUses: 2,
};
const context = { region: 'AU', namespace: 'synthetic' };

function fixtures() {
  const stored = new Map<string, Buffer>();
  const keys: TemporalKeyService = {
    generate: vi.fn(async () => {
      const plaintext = randomBytes(32);
      const wrappedKey = randomBytes(48);
      stored.set(wrappedKey.toString('base64'), Buffer.from(plaintext));

      return { plaintext, wrappedKey };
    }),
    decrypt: vi.fn(async (_arn, wrapped) => {
      const plaintext = stored.get(Buffer.from(wrapped).toString('base64'));
      if (!plaintext) throw new Error('KMS denied');

      return Buffer.from(plaintext);
    }),
  };

  return keys;
}

const payload = defaultPayloadConverter.toPayload({
  customer: 'sensitive-customer',
  nested: ['private'],
});

describe('regional Temporal payload encryption', () => {
  it('round-trips complete payloads without exposing data or encoding metadata', async () => {
    const keys = fixtures();
    const codec = createTemporalPayloadCodec(settings, context, { keys });
    const encoded = await codec.encode([payload]);
    expect(Buffer.from(encoded[0]!.data!).toString()).not.toContain(
      'sensitive-customer',
    );
    expect(encoded[0]!.metadata!.encoding).toEqual(
      Buffer.from('binary/luma-kms-v1'),
    );
    expect(await codec.decode(encoded)).toEqual([payload]);
    expect(await codec.encode([])).toEqual([]);
    expect(await codec.decode([])).toEqual([]);
    codec.close();
    await expect(codec.encode([payload])).rejects.toThrow('closed');
  });

  it('rejects plaintext, cross-region data and tampering before running an activity', async () => {
    const keys = fixtures();
    const codec = createTemporalPayloadCodec(settings, context, { keys });
    await expect(codec.decode([payload])).rejects.toThrow('format rejected');
    const [encoded] = await codec.encode([payload]);
    const foreign = createTemporalPayloadCodec(
      settings,
      { ...context, region: 'EU' },
      { keys },
    );
    await expect(foreign.decode([encoded!])).rejects.toThrow('region');
    expect(keys.decrypt).not.toHaveBeenCalled();
    const value = JSON.parse(Buffer.from(encoded!.data!).toString()) as {
      ciphertext: string;
    };
    value.ciphertext = Buffer.alloc(32).toString('base64');
    await expect(
      codec.decode([{ ...encoded!, data: Buffer.from(JSON.stringify(value)) }]),
    ).rejects.toThrow();
    const detect = vi.fn<(input: unknown) => Promise<void>>(
      async () => undefined,
    );
    const activities = temporalActivities({ detect }, undefined, 'AU');
    await expect(
      activities.detect({ dataRegion: 'EU', tenantId: 'foreign' }),
    ).rejects.toMatchObject({
      type: 'WorkflowRegionRejected',
      nonRetryable: true,
    });
    await expect(
      activities.detect({ tenantId: 'unknown' }),
    ).rejects.toMatchObject({ type: 'WorkflowRegionRejected' });
    expect(detect).not.toHaveBeenCalled();
    await activities.detect({ dataRegion: 'AU', tenantId: 'local' });
    expect(detect).toHaveBeenCalledOnce();
  });

  it('bounds key reuse and fails closed after KMS loses access', async () => {
    const keys = fixtures();
    let clock = 0;
    const codec = createTemporalPayloadCodec(settings, context, {
      keys,
      now: () => clock,
    });
    const encrypted = await codec.encode([payload, payload]);
    expect(keys.generate).toHaveBeenCalledOnce();
    vi.mocked(keys.generate).mockRejectedValue(new Error('KMS offline'));
    await expect(codec.encode([payload])).rejects.toThrow('KMS offline');
    await codec.decode(encrypted);
    expect(keys.decrypt).toHaveBeenCalledOnce();
    vi.mocked(keys.decrypt).mockRejectedValue(new Error('KMS revoked'));
    await expect(codec.decode(encrypted)).rejects.toThrow('KMS revoked');
    const reader = createTemporalPayloadCodec(settings, context, {
      keys,
      now: () => clock,
    });
    vi.mocked(keys.decrypt).mockImplementation(fixtures().decrypt);
    // A fresh worker without the original KMS wrapping key cannot read history.
    await expect(reader.decode(encrypted)).rejects.toThrow('KMS denied');
    clock = 1001;
    await expect(codec.encode([payload])).rejects.toThrow('KMS offline');
  });

  it('retains access to explicitly allowed old keys across rotation', async () => {
    const keys = fixtures();
    const old = createTemporalPayloadCodec(
      { ...settings, keyArn: previousArn },
      context,
      { keys },
    );
    const history = await old.encode([payload]);
    const rotated = createTemporalPayloadCodec(
      { ...settings, decryptionKeyArns: [previousArn] },
      context,
      { keys },
    );
    expect(await rotated.decode(history)).toEqual([payload]);
    const retired = createTemporalPayloadCodec(settings, context, { keys });
    await expect(retired.decode(history)).rejects.toThrow(
      'history encryption key unavailable',
    );
  });

  it.each([1, 2])(
    'reserves at most %i uses per data key across concurrent encoders',
    async (cacheMaxUses) => {
      const keys = fixtures();
      const codec = createTemporalPayloadCodec(
        { ...settings, cacheMaxUses },
        context,
        { keys },
      );
      const originals = Array.from({ length: 12 }, (_, index) =>
        defaultPayloadConverter.toPayload({
          index,
          private: 'concurrent-customer',
        }),
      );
      const batches = await Promise.all(
        originals.map((original) => codec.encode([original])),
      );
      expect(keys.generate).toHaveBeenCalledTimes(12 / cacheMaxUses);
      const reader = createTemporalPayloadCodec(
        { ...settings, cacheMaxUses: 100 },
        context,
        { keys },
      );
      const decrypted = await Promise.all(
        batches.map((batch) => reader.decode(batch)),
      );
      expect(decrypted).toEqual(originals.map((original) => [original]));
      expect(keys.decrypt).toHaveBeenCalledTimes(12 / cacheMaxUses);
      codec.close();
      reader.close();
    },
  );

  it('keeps a reserved key intact while another encoder rotates an expired cache entry', async () => {
    const keys = fixtures();
    let clock = 0;
    const codec = createTemporalPayloadCodec(
      { ...settings, cacheMaxUses: 100 },
      context,
      { keys, now: () => clock },
    );
    await codec.encode([payload]);
    const pending = codec.encode([payload]);
    clock = 1001;
    const rotated = codec.encode([payload]);
    const batches = await Promise.all([pending, rotated]);
    expect(keys.generate).toHaveBeenCalledTimes(2);
    expect(
      await Promise.all(batches.map((batch) => codec.decode(batch))),
    ).toEqual([[payload], [payload]]);
    codec.close();
  });

  it('deduplicates concurrent decrypt misses and bounds reservations during read-key rotation', async () => {
    const keys = fixtures();
    const writer = createTemporalPayloadCodec(settings, context, { keys });
    const history = await writer.encode([payload]);
    const reader = createTemporalPayloadCodec(settings, context, { keys });
    const batches = await Promise.all(
      Array.from({ length: 12 }, () => reader.decode(history)),
    );
    expect(batches).toEqual(Array.from({ length: 12 }, () => [payload]));
    expect(keys.decrypt).toHaveBeenCalledTimes(6);
    writer.close();
    reader.close();
  });
});
