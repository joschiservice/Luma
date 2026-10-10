import '../src/styles/globals.css';

import type { Preview } from '@storybook/react-vite';
import { configure } from 'storybook/test';

// One wait budget for every play function, instead of per-query timeouts. Waits still end as
// soon as the element appears; the budget covers debounced saves and slow renders under load.
configure({ asyncUtilTimeout: 5000 });

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
