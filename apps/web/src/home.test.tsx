import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Home } from './home';

it('renders the landing page on the server without browser globals or services', () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html).toContain('<main>');
  expect(html).toContain('<h1>');
  expect(html).toContain('Your operations workspace is taking shape.');
});
