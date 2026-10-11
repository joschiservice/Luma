import { expect, it } from 'vitest';

import { readGmailConfig } from './config.js';

const settings = {
  GMAIL_CLIENT_ID: 'client.apps.googleusercontent.com',
  GMAIL_CLIENT_SECRET: 'secret',
  GMAIL_APP_ENVIRONMENT: 'development',
  GMAIL_CALLBACK_URL: 'https://luma.test/api/v1/gmail/callback',
  GMAIL_WEB_ORIGIN: 'https://luma.test',
};

const push = {
  GMAIL_PUBSUB_TOPIC: 'projects/luma-test/topics/gmail-push',
  GMAIL_PUSH_AUDIENCE: 'https://luma.test/api/v1/gmail/push',
  GMAIL_PUSH_SERVICE_ACCOUNT: 'Push@luma-test.iam.gserviceaccount.com',
};

it('requires a complete app configuration and exact HTTPS callback', () => {
  expect(readGmailConfig({})).toBeUndefined();
  expect(readGmailConfig(settings)).toMatchObject({
    environment: 'development',
    callbackUrl: settings.GMAIL_CALLBACK_URL,
    webOrigin: 'https://luma.test',
  });
  expect(readGmailConfig(settings)?.push).toBeUndefined();
  expect(() => readGmailConfig({ GMAIL_CLIENT_ID: 'client' })).toThrow();
  for (const url of [
    'http://luma.test/api/v1/gmail/callback',
    'https://luma.test/wrong',
    'https://luma.test/api/v1/gmail/callback?x=y',
    'https://secret@luma.test/api/v1/gmail/callback',
    'https://other.test/api/v1/gmail/callback',
  ])
    expect(() =>
      readGmailConfig({ ...settings, GMAIL_CALLBACK_URL: url }),
    ).toThrow();
  expect(() =>
    readGmailConfig({
      ...settings,
      NODE_ENV: 'production',
      GMAIL_WEB_ORIGIN: 'http://luma.test',
    }),
  ).toThrow();
});

it('reads optional push settings only together and with OAuth settings', () => {
  expect(readGmailConfig({ ...settings, ...push })?.push).toEqual({
    topic: push.GMAIL_PUBSUB_TOPIC,
    audience: push.GMAIL_PUSH_AUDIENCE,
    serviceAccount: 'push@luma-test.iam.gserviceaccount.com',
  });
  expect(() => readGmailConfig(push)).toThrow();
  expect(() =>
    readGmailConfig({
      ...settings,
      GMAIL_PUBSUB_TOPIC: push.GMAIL_PUBSUB_TOPIC,
    }),
  ).toThrow();
  expect(() =>
    readGmailConfig({ ...settings, ...push, GMAIL_PUBSUB_TOPIC: 'gmail-push' }),
  ).toThrow();
});
