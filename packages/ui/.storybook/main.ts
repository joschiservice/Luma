import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: [
    '../src/**/*.stories.@(ts|tsx)',
    '../../../apps/web/src/**/*.stories.@(ts|tsx)',
  ],
  framework: '@storybook/react-vite',
  core: { disableTelemetry: true },
  addons: ['@storybook/addon-vitest', '@storybook/addon-a11y'],
  viteFinal(config) {
    config.plugins ??= [];
    config.plugins.push({
      name: 'luma:storybook-docgen',
      configResolved(resolvedConfig) {
        const docgen = resolvedConfig.plugins.find(
          (plugin) => plugin.name === 'storybook:react-docgen-plugin',
        );

        // Generated message functions are not components. Parsing their large
        // export graph blocks the dev server's event loop during preview loading.
        if (docgen && typeof docgen.transform === 'function') {
          docgen.transform = {
            filter: { id: { exclude: /\/i18n\/dist\/paraglide\// } },
            handler: docgen.transform,
          };
        }
      },
    });

    return config;
  },
};

export default config;
