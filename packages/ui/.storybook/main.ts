import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: [
    '../src/**/*.stories.@(ts|tsx)',
    '../../../apps/web/src/**/*.stories.@(ts|tsx)',
  ],
  framework: '@storybook/react-vite',
  core: { disableTelemetry: true },
  addons: [
    '@storybook/addon-vitest',
    '@storybook/addon-a11y',
  ],
};

export default config;
