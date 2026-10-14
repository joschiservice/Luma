import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { DataConverter, Payload, PayloadCodec } from '@temporalio/common';
import { z } from 'zod';

const encoding = 'binary/luma-kms-v1';
const bytes = (value: string) => Buffer.from(value, 'utf8');
const base64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const encryptedSchema = z
  .object({
    keyArn: z.string(),
    wrappedKey: base64,
    nonce: base64,
    tag: base64,
    ciphertext: base64,
  })
  .strict();
const payloadSchema = z
  .object({
    metadata: z.record(z.string(), base64).optional(),
    data: base64.optional(),
  })
  .strict();

export interface TemporalPayloadEncryption {
  keyArn: string;
  decryptionKeyArns: string[];
  kmsRegion: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  cacheTtlMs: number;
  cacheMaxUses: number;
}

/** KMS operations return an unwrapped AES-256 data key only to the regional process. */
export interface TemporalKeyService {
  generate(
    keyArn: string,
  ): Promise<{ plaintext: Uint8Array; wrappedKey: Uint8Array }>;
  decrypt(keyArn: string, wrappedKey: Uint8Array): Promise<Uint8Array>;
}

interface CachedKey {
  plaintext: Buffer;
  wrappedKey: string;
  expires: number;
  uses: number;
}

/**
 * Encrypts complete Temporal payloads with AES-256-GCM and regional KMS-wrapped data keys.
 * Rejects plaintext, foreign-region data, tampering and retired keys. Cached keys are bounded
 * by age and use count; cache misses fail closed when KMS is unavailable.
 */
export function createTemporalPayloadCodec(
  settings: TemporalPayloadEncryption,
  context: { region: string; namespace: string },
  dependencies: { keys: TemporalKeyService; now?: () => number },
): PayloadCodec & { close(): void } {
  const keys = dependencies.keys;
  const now = dependencies.now ?? Date.now;
  const permitted = new Set([settings.keyArn, ...settings.decryptionKeyArns]);
  const decoded = new Map<string, CachedKey>();
  let write: CachedKey | undefined;
  let generating: Promise<void> | undefined;
  const decrypting = new Map<string, Promise<void>>();
  let closed = false;

  function usable(key: CachedKey) {
    return key.expires > now() && key.uses < settings.cacheMaxUses;
  }

  function cached(plaintext: Uint8Array, wrappedKey: string): CachedKey {
    if (plaintext.length !== 32) throw new Error('Invalid Temporal data key');

    return {
      plaintext: Buffer.from(plaintext),
      wrappedKey,
      expires: now() + settings.cacheTtlMs,
      uses: 0,
    };
  }

  function requireOpen() {
    if (closed) throw new Error('Temporal payload codec closed');
  }

  function aad(keyArn: string, wrappedKey: string) {
    return bytes(
      JSON.stringify([
        encoding,
        context.region,
        context.namespace,
        keyArn,
        wrappedKey,
      ]),
    );
  }

  function reserve(key: CachedKey) {
    // Reserve synchronously before returning through an await boundary. Each operation owns
    // its copy, so expiry, rotation or eviction cannot wipe a key that is still in use.
    key.uses += 1;

    return {
      plaintext: Buffer.from(key.plaintext),
      wrappedKey: key.wrappedKey,
    };
  }

  async function encryptionKey() {
    for (;;) {
      requireOpen();
      if (write && usable(write)) return reserve(write);
      write?.plaintext.fill(0);
      write = undefined;
      generating ??= keys
        .generate(settings.keyArn)
        .then((key) => {
          let next: CachedKey;
          try {
            next = cached(
              key.plaintext,
              Buffer.from(key.wrappedKey).toString('base64'),
            );
          } finally {
            key.plaintext.fill(0);
          }
          if (closed) {
            next.plaintext.fill(0);
            throw new Error('Temporal payload codec closed');
          }
          write = next;
        })
        .finally(() => {
          generating = undefined;
        });
      await generating;
      // Other waiting encoders may have consumed this generation's allowance already.
    }
  }

  async function decryptionKey(keyArn: string, wrappedKey: string) {
    const id = `${keyArn}:${wrappedKey}`;
    for (;;) {
      requireOpen();
      const key = decoded.get(id);
      if (key && usable(key)) return reserve(key);
      key?.plaintext.fill(0);
      decoded.delete(id);
      let pending = decrypting.get(id);
      if (!pending) {
        pending = keys
          .decrypt(keyArn, Buffer.from(wrappedKey, 'base64'))
          .then((plaintext) => {
            let next: CachedKey;
            try {
              next = cached(plaintext, wrappedKey);
            } finally {
              plaintext.fill(0);
            }
            if (closed) {
              next.plaintext.fill(0);
              throw new Error('Temporal payload codec closed');
            }
            // Histories can span many rotations; eviction only wipes cache-owned bytes.
            if (decoded.size >= 64) {
              const oldest = decoded.entries().next().value;
              if (oldest) {
                oldest[1].plaintext.fill(0);
                decoded.delete(oldest[0]);
              }
            }
            decoded.set(id, next);
          })
          .finally(() => {
            decrypting.delete(id);
          });
        decrypting.set(id, pending);
      }
      await pending;
    }
  }

  return {
    async encode(payloads) {
      const result: Payload[] = [];
      for (const payload of payloads) {
        const key = await encryptionKey();
        try {
          requireOpen();
          const nonce = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', key.plaintext, nonce);
          cipher.setAAD(aad(settings.keyArn, key.wrappedKey));
          const serialized = JSON.stringify({
            ...(payload.metadata
              ? {
                  metadata: Object.fromEntries(
                    Object.entries(payload.metadata).map(([name, value]) => [
                      name,
                      Buffer.from(value).toString('base64'),
                    ]),
                  ),
                }
              : {}),
            ...(payload.data
              ? { data: Buffer.from(payload.data).toString('base64') }
              : {}),
          });
          const ciphertext = Buffer.concat([
            cipher.update(serialized, 'utf8'),
            cipher.final(),
          ]);
          result.push({
            metadata: {
              encoding: bytes(encoding),
              region: bytes(context.region),
              namespace: bytes(context.namespace),
            },
            data: bytes(
              JSON.stringify({
                keyArn: settings.keyArn,
                wrappedKey: key.wrappedKey,
                nonce: nonce.toString('base64'),
                tag: cipher.getAuthTag().toString('base64'),
                ciphertext: ciphertext.toString('base64'),
              }),
            ),
          });
        } finally {
          key.plaintext.fill(0);
        }
      }

      return result;
    },
    async decode(payloads) {
      requireOpen();
      const result: Payload[] = [];
      for (const payload of payloads) {
        if (
          Buffer.from(payload.metadata?.encoding ?? []).toString() !==
            encoding ||
          Buffer.from(payload.metadata?.region ?? []).toString() !==
            context.region ||
          Buffer.from(payload.metadata?.namespace ?? []).toString() !==
            context.namespace ||
          !payload.data
        )
          throw new Error(
            'Temporal encrypted payload region or format rejected',
          );
        const value = encryptedSchema.parse(
          JSON.parse(Buffer.from(payload.data).toString('utf8')),
        );
        if (!permitted.has(value.keyArn))
          throw new Error('Temporal history encryption key unavailable');
        const nonce = Buffer.from(value.nonce, 'base64');
        const tag = Buffer.from(value.tag, 'base64');
        if (nonce.length !== 12 || tag.length !== 16)
          throw new Error('Invalid Temporal encrypted payload');
        const key = await decryptionKey(value.keyArn, value.wrappedKey);
        try {
          requireOpen();
          const decipher = createDecipheriv(
            'aes-256-gcm',
            key.plaintext,
            nonce,
          );
          decipher.setAAD(aad(value.keyArn, value.wrappedKey));
          decipher.setAuthTag(tag);
          const plaintext = Buffer.concat([
            decipher.update(Buffer.from(value.ciphertext, 'base64')),
            decipher.final(),
          ]);
          const original = payloadSchema.parse(
            JSON.parse(plaintext.toString('utf8')),
          );
          plaintext.fill(0);
          result.push({
            ...(original.metadata
              ? {
                  metadata: Object.fromEntries(
                    Object.entries(original.metadata).map(([name, value]) => [
                      name,
                      Uint8Array.from(Buffer.from(value, 'base64')),
                    ]),
                  ),
                }
              : {}),
            ...(original.data !== undefined
              ? { data: Uint8Array.from(Buffer.from(original.data, 'base64')) }
              : {}),
          });
        } finally {
          key.plaintext.fill(0);
        }
      }

      return result;
    },
    close() {
      closed = true;
      write?.plaintext.fill(0);
      for (const key of decoded.values()) key.plaintext.fill(0);
      decoded.clear();
    },
  };
}

/** Installs encryption and encoded failure attributes together for every client and worker. */
export function temporalDataConverter(settings: {
  dataRegion: string;
  namespace: string;
  payloadEncryption?: TemporalPayloadEncryption;
  payloadKeyService?: TemporalKeyService;
}): { converter: DataConverter; close(): void } {
  if (settings.payloadEncryption && !settings.payloadKeyService)
    throw new Error('Temporal encryption key service is required');
  const codec =
    settings.payloadEncryption && settings.payloadKeyService
      ? createTemporalPayloadCodec(
          settings.payloadEncryption,
          {
            region: settings.dataRegion,
            namespace: settings.namespace,
          },
          { keys: settings.payloadKeyService },
        )
      : undefined;

  return {
    converter: codec
      ? {
          payloadCodecs: [codec],
          failureConverterPath: fileURLToPath(
            new URL(
              existsSync(
                fileURLToPath(
                  new URL('./failure-converter.js', import.meta.url),
                ),
              )
                ? './failure-converter.js'
                : './failure-converter.ts',
              import.meta.url,
            ),
          ),
        }
      : {},
    close: () => codec?.close(),
  };
}
