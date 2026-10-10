#!/usr/bin/env node
/**
 * Captures the Marketing/Screenshots stories as PNGs for the Auren website, in every interface
 * language. Builds Storybook first unless `--skip-build` is passed, serves the static build on a
 * free local port and writes `<screen>-<locale>.png` files to `--out` (default
 * `packages/ui/dist/marketing-screenshots`). The clock is frozen so relative times and greetings are the
 * same on every run.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { chromium } from 'playwright';

const packageDir = resolve(import.meta.dirname, '..');
const staticDir = join(packageDir, 'storybook-static');
const locales = ['en', 'de'];
const timeZone = 'Europe/Berlin';
// A Thursday morning in the workspace's time zone.
const frozenAt = new Date('2026-10-08T07:42:00.000Z');

/**
 * Each screen is a story, a theme and a viewport. Output pixels are the viewport times the scale,
 * matching the image slots on the website.
 */
const screens = [
  {
    name: 'home-dark',
    story: 'marketing-screenshots--home',
    theme: 'dark',
    viewport: { width: 1440, height: 810 },
    scale: 2400 / 1440,
    ready: '.operations-decisions li',
  },
  {
    name: 'needs-you-light',
    story: 'marketing-screenshots--needs-you',
    theme: 'light',
    viewport: { width: 1440, height: 900 },
    scale: 2400 / 1440,
    ready: '.decision-review',
  },
  {
    name: 'order-record-dark',
    story: 'marketing-screenshots--order-record',
    theme: 'dark',
    viewport: { width: 1280, height: 800 },
    scale: 2400 / 1280,
    ready: 'main h1',
  },
];

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
  },
});
// pnpm runs package scripts in the package directory; resolve --out from where it was invoked.
const outDir = values.out
  ? resolve(process.env.INIT_CWD ?? process.cwd(), values.out)
  : join(packageDir, 'dist', 'marketing-screenshots');

if (!values['skip-build']) {
  const build = spawnSync(
    'pnpm',
    ['exec', 'storybook', 'build', '--output-dir', staticDir, '--quiet'],
    { cwd: packageDir, stdio: 'inherit' },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
}

/** Serves the static Storybook build; paths outside it are not found. */
function serve() {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(
      new URL(request.url ?? '/', 'http://local').pathname,
    );
    const file = join(staticDir, path === '/' ? 'index.html' : path);
    const found =
      file.startsWith(staticDir) &&
      (await stat(file).catch(() => null))?.isFile();
    if (!found) {
      response.writeHead(404).end();

      return;
    }
    response.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(response);
  });

  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
await mkdir(outDir, { recursive: true });

try {
  for (const screen of screens) {
    for (const locale of locales) {
      const context = await browser.newContext({
        viewport: screen.viewport,
        deviceScaleFactor: screen.scale,
        locale: locale === 'de' ? 'de-DE' : 'en-GB',
        timezoneId: timeZone,
        reducedMotion: 'reduce',
      });
      await context.addCookies([
        { name: 'luma_locale', value: locale, url: base },
      ]);
      const page = await context.newPage();
      await page.clock.setFixedTime(frozenAt);
      await page.goto(
        `${base}/iframe.html?id=${screen.story}&viewMode=story&globals=theme:${screen.theme}`,
      );
      await page
        .locator(screen.ready)
        .first()
        .waitFor({ state: 'attached', timeout: 30_000 });
      await page.evaluate('document.fonts.ready');
      const file = join(outDir, `${screen.name}-${locale}.png`);
      await page.screenshot({ path: file });
      console.log(`Saved ${file}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
