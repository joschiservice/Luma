import { fumadocsMdx } from 'fumadocs-mdx/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [fumadocsMdx({ index: false })],
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
});
