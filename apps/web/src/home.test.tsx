import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { Home } from './home';

it('renders the landing page on the server without browser globals or services', () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html).toContain('<main class="landing">');
  expect(html).toContain('Spend less time fixing the same order problems');
  expect(html).toContain('href="/sign-in"');
  expect(html).toContain('href="/sign-up"');
});
