import { describe, expect, it } from 'vitest';

import { signAwsRequest } from './aws-signature.js';

// Published AWS Signature Version 4 examples: aws-sig-v4-test-suite and the IAM ListUsers
// walkthrough from the AWS General Reference.
const example = {
  service: 'service',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  },
  date: new Date('2015-08-30T12:36:00Z'),
};

describe('AWS Signature Version 4', () => {
  it.each([
    [
      'get-vanilla',
      'GET',
      'https://example.amazonaws.com/',
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    ],
    [
      'get-vanilla-query-order-key-case',
      'GET',
      'https://example.amazonaws.com/?Param2=value2&Param1=value1',
      'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    ],
    [
      'post-vanilla',
      'POST',
      'https://example.amazonaws.com/',
      '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    ],
  ])('matches the %s test vector', (_name, method, url, signature) => {
    expect(signAwsRequest({ ...example, method, url: new URL(url) })).toEqual({
      'x-amz-date': '20150830T123600Z',
      authorization: `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature}`,
    });
  });

  it('matches the IAM ListUsers example with a signed content type', () => {
    expect(
      signAwsRequest({
        ...example,
        service: 'iam',
        method: 'GET',
        url: new URL(
          'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
        ),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
      }).authorization,
    ).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  // Reference signatures produced by @smithy/signature-v4, the signer used by AWS SDK v3.
  // They cover double-encoded model IDs, session tokens and the payload hash header.
  it.each([
    [
      'POST',
      'https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse',
      'content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
      'a60262ad9a9e6a0de9bac4ed147895543a0ca6fc277fb4729442117b44903791',
    ],
    [
      'GET',
      'https://bedrock.eu-central-1.amazonaws.com/logging/modelinvocations',
      'host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
      '63891a44df63060cdb97f8eba78e1d02930e4540339884fe9372142b140fc651',
    ],
    [
      'GET',
      'https://bedrock.eu-central-1.amazonaws.com/inference-profiles/eu.anthropic.claude-sonnet-4-5-20250929-v1%3A0',
      'host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
      'f35af23458276e3b8c0f161eac0da2501833d60e626839e034e27c770ce37ff4',
    ],
  ])(
    'matches the AWS SDK signer for %s %s',
    (method, url, signed, signature) => {
      const post = method === 'POST';
      const headers = signAwsRequest({
        method,
        url: new URL(url),
        service: 'bedrock',
        region: 'eu-central-1',
        credentials: {
          ...example.credentials,
          sessionToken: 'token/with+chars==',
        },
        date: new Date('2026-09-28T10:11:12Z'),
        signPayloadHash: true,
        ...(post
          ? {
              headers: { 'content-type': 'application/json' },
              body: '{"messages":[{"role":"user","content":[{"text":"hi"}]}]}',
            }
          : {}),
      });
      expect(headers.authorization).toBe(
        `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260928/eu-central-1/bedrock/aws4_request, SignedHeaders=${signed}, Signature=${signature}`,
      );
      expect(headers['x-amz-security-token']).toBe('token/with+chars==');
      expect(headers).not.toHaveProperty('host');
    },
  );

  it('binds the body to the signature', () => {
    const sign = (body: string) =>
      signAwsRequest({
        ...example,
        method: 'POST',
        url: new URL('https://example.amazonaws.com/'),
        body,
      }).authorization;
    expect(sign('{}')).not.toBe(sign('{ }'));
  });
});
