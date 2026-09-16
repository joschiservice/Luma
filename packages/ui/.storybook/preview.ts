import type { Preview } from '@storybook/react-vite';

const preview: Preview = {
  parameters: {
    layout: 'centered',
    a11y: { test: 'error' },
  },
};

export default preview;
