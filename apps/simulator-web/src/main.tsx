import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { initialToken } from './api';
import { App } from './app';
import { followSystemTheme } from './lib/theme';

followSystemTheme();
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App initialToken={initialToken()} />
    </StrictMode>,
  );
