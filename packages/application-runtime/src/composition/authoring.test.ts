import { expect, it } from 'vitest';

import { assistantAvailability, authoringAvailability } from './authoring.js';

const bedrock = {
  region: 'eu-central-1',
  credentials: { accessKeyId: 'AKIAEXAMPLE0000000', secretAccessKey: 'secret' },
};
const route = {
  adapter: 'bedrock' as const,
  model: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
  providers: ['bedrock'],
  zeroDataRetention: true,
};

it('allows authoring only on an EU Bedrock route with zero data retention', () => {
  expect(
    authoringAvailability(
      {
        dataRegion: 'EU' as const,
        routes: { authoring: route },
        bedrock,
        timeoutMs: 1000,
      },
      true,
    ),
  ).toEqual({ available: true, reason: null });

  for (const [settings, installed, reason] of [
    [undefined, false, /aren’t configured/],
    [
      { dataRegion: 'EU' as const, routes: {}, timeoutMs: 1000 },
      true,
      /configure the authoring route/,
    ],
    [
      {
        dataRegion: 'EU' as const,
        routes: { authoring: { ...route, adapter: 'vercel' as const } },
        apiKey: 'key',
        timeoutMs: 1000,
      },
      true,
      /doesn’t process data in the cell region/,
    ],
    [
      {
        dataRegion: 'EU' as const,
        routes: { authoring: { ...route, zeroDataRetention: false } },
        bedrock,
        timeoutMs: 1000,
      },
      true,
      /zero data retention\.$/,
    ],
    [
      {
        dataRegion: 'EU' as const,
        routes: { authoring: route },
        timeoutMs: 1000,
      },
      true,
      /Bedrock isn’t configured/,
    ],
  ] as const) {
    const result = authoringAvailability(settings, installed);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(reason);
    expect(result.reason).toMatch(
      /^Describing workflows needs a regional model route/,
    );
  }
});

it('gives the assistant its own EU route', () => {
  expect(
    assistantAvailability(
      {
        dataRegion: 'EU' as const,
        routes: { assistant: route },
        bedrock,
        timeoutMs: 1000,
      },
      true,
    ),
  ).toEqual({ available: true, reason: null });

  // An authoring route doesn't enable the assistant.
  const result = assistantAvailability(
    {
      dataRegion: 'EU' as const,
      routes: { authoring: route },
      bedrock,
      timeoutMs: 1000,
    },
    true,
  );
  expect(result.available).toBe(false);
  expect(result.reason).toBe(
    'Asking Luma needs a regional model route with zero data retention. Whoever runs this Luma server needs to configure the assistant route.',
  );
});
