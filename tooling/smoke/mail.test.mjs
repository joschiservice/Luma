import assert from 'node:assert/strict';
import { test } from 'node:test';

import { messageLinks, messageRecipients } from './mail.mjs';

const origin = 'https://au.app.staging.example.com';

const multipart = [
  'From: Luma <no-reply@staging.example.com>',
  'To: "Smoke" <Smoke+run1@inbox.staging.example.com>',
  'Subject: Confirm your email',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative;',
  '\tboundary="outer"',
  '',
  '--outer',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Confirm: https://au.app.staging.example.com/verify-email#abc=3Ddef-very-lo=',
  'ng-token.',
  'Elsewhere: https://evil.example/verify-email#stolen',
  '--outer',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(
    '<a href="https://au.app.staging.example.com/app/invitations/o/i?x=1&amp;y=2#t">Join</a>',
  ).toString('base64'),
  '--outer--',
  '',
].join('\r\n');

test('finds the recipients of a message', () => {
  assert.deepEqual(messageRecipients(multipart), [
    'smoke+run1@inbox.staging.example.com',
  ]);
});

test('decodes quoted-printable and base64 parts and keeps only links on the origin', () => {
  assert.deepEqual(
    messageLinks(multipart, origin).map((url) => url.href),
    [
      'https://au.app.staging.example.com/verify-email#abc=def-very-long-token',
      'https://au.app.staging.example.com/app/invitations/o/i?x=1&y=2#t',
    ],
  );
});

test('reads a single-part message and ignores links to a look-alike origin', () => {
  const raw = [
    'To: smoke+run1-b@inbox.staging.example.com',
    'Content-Type: text/plain',
    '',
    'https://au.app.staging.example.com.evil.example/app/invitations/o/i#t',
    'http://au.app.staging.example.com/app/invitations/o/i#t',
    'https://au.app.staging.example.com/app/invitations/o/i#t',
  ].join('\n');

  assert.deepEqual(messageRecipients(raw), [
    'smoke+run1-b@inbox.staging.example.com',
  ]);
  assert.deepEqual(
    messageLinks(raw, origin).map((url) => url.href),
    ['https://au.app.staging.example.com/app/invitations/o/i#t'],
  );
});

test('returns nothing for a message without text parts', () => {
  const raw = [
    'To: a@example.com',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    '',
    'aGVsbG8=',
  ].join('\n');

  assert.deepEqual(messageLinks(raw, origin), []);
});
