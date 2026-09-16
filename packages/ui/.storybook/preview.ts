import type { Preview } from '@storybook/react-vite';
import '../src/styles/globals.css';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Luma color theme',
      toolbar: {
        icon: 'paintbrush',
        items: ['light', 'dark'],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [
    (Story, context) => {
      // Theme the document so portaled overlays receive the same tokens.
      document.documentElement.classList.toggle(
        'dark',
        context.globals.theme === 'dark',
      );
      return Story();
    },
  ],
  parameters: {
    layout: 'centered',
    a11y: { test: 'error' },
  },
};

export default preview;
