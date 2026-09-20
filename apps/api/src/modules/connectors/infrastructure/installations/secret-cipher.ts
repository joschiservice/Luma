import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { SecretCipher } from '#modules/connectors/application/installations';
import { storedCredentials } from '#modules/connectors/infrastructure/installations/validation';

/** Keys are supplied by the deployment secret manager and never stored with ciphertext. */
export function createSecretCipher(
  activeKeyId: string,
  keys: ReadonlyMap<string, Uint8Array>,
): SecretCipher {
  const keyring = new Map([...keys].map(([id, key]) => [id, Buffer.from(key)]));
  if (
    !keyring.has(activeKeyId) ||
    [...keyring.values()].some((key) => key.length !== 32)
  )
    throw new Error('Invalid connection encryption key configuration');

  return {
    seal(value, binding) {
      const iv = randomBytes(12);
      const cipher = createCipheriv(
        'aes-256-gcm',
        keyring.get(activeKeyId)!,
        iv,
      );
      cipher.setAAD(Buffer.from(binding));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
      ]);

      return JSON.stringify({
        keyId: activeKeyId,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      });
    },
    open(value, binding) {
      try {
        const envelope = JSON.parse(value) as {
          keyId: string;
          iv: string;
          tag: string;
          ciphertext: string;
        };
        const key = keyring.get(envelope.keyId);
        if (!key) throw new Error();
        const iv = Buffer.from(envelope.iv, 'base64');
        const tag = Buffer.from(envelope.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(binding));
        decipher.setAuthTag(tag);

        return storedCredentials.parse(
          JSON.parse(
            Buffer.concat([
              decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
              decipher.final(),
            ]).toString('utf8'),
          ),
        );
      } catch {
        throw new Error('Connection credentials unavailable');
      }
    },
  };
}
