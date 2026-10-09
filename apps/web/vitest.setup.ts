// Feature modules create `/api` clients that resolve against the page URL; tests run in Node.
// Defined directly so tests that call `vi.unstubAllGlobals()` keep it.
Object.defineProperty(globalThis, 'location', {
  value: { href: 'http://localhost/' },
  configurable: true,
});
