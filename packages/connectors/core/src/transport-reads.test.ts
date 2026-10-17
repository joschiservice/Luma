import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCursorCodec, createPayloadCapture } from './transport.js';

const schema = z
  .object({ binding: z.string(), page: z.number().int().min(2) })
  .strict();

describe('createCursorCodec', () => {
  it('keeps the existing base64url JSON wire format', () => {
    const codec = createCursorCodec(schema);
    const cursor = codec.encode({ binding: 'b', page: 2 });

    expect(cursor).toBe(
      Buffer.from('{"binding":"b","page":2}').toString('base64url'),
    );
    expect(codec.decode(cursor)).toEqual({ binding: 'b', page: 2 });
  });

  it.each([
    ['not base64 json', 'not-json'],
    [
      'schema mismatch',
      Buffer.from('{"binding":"b","page":1}').toString('base64url'),
    ],
    [
      'unknown field',
      Buffer.from('{"binding":"b","page":2,"x":1}').toString('base64url'),
    ],
  ])('rejects %s as invalid input', (_name, cursor) => {
    expect(() => createCursorCodec(schema).decode(cursor)).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({ code: 'invalid_input' }),
      }),
    );
  });

  it('rejects non-canonical base64url only when requested', () => {
    const cursor = `${Buffer.from('{"binding":"b","page":2}').toString('base64url')}=`;

    expect(createCursorCodec(schema).decode(cursor)).toEqual({
      binding: 'b',
      page: 2,
    });
    expect(() =>
      createCursorCodec(schema, { canonical: true }).decode(cursor),
    ).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({ code: 'invalid_input' }),
      }),
    );
  });
});

describe('createPayloadCapture', () => {
  const now = () => new Date('2026-10-14T05:00:00Z');

  it('retains parsed payloads with their expiry', () => {
    const payloads = createPayloadCapture(60_000, now);

    expect(
      payloads.capture(z.object({ id: z.string() }), { id: 'a', x: 1 }),
    ).toEqual({
      id: 'a',
    });
    expect(payloads.raw()).toEqual({
      raw: { payloads: [{ id: 'a' }], expiresAt: '2026-10-14T05:01:00.000Z' },
    });
  });

  it('keeps nothing without retention and rejects invalid responses', () => {
    const payloads = createPayloadCapture(undefined, now);

    payloads.capture(z.string(), 'value');
    expect(payloads.raw()).toEqual({});
    expect(() => payloads.capture(z.string(), 1)).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({ code: 'invalid_response' }),
      }),
    );
  });
});
