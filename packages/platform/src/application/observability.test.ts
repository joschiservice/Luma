import { expect, it, vi } from 'vitest';

import { logStaticFeatureFlags } from './observability.js';

it('logs static feature flags once with their values', () => {
  const write = vi.fn();

  logStaticFeatureFlags(
    { 'stock-protection': true, 'purchasing-outcomes': false },
    write,
  );

  expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith('Static feature flags', {
    featureFlags: { 'stock-protection': true, 'purchasing-outcomes': false },
  });
});

it('logs nothing without static feature flags', () => {
  const write = vi.fn();

  logStaticFeatureFlags(undefined, write);
  logStaticFeatureFlags({}, write);

  expect(write).not.toHaveBeenCalled();
});

it('writes one JSON line by default', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  try {
    logStaticFeatureFlags({ 'stock-protection': true });

    expect(info).toHaveBeenCalledOnce();
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      level: 'INFO',
      message: 'Static feature flags',
      featureFlags: { 'stock-protection': true },
    });
  } finally {
    info.mockRestore();
  }
});
