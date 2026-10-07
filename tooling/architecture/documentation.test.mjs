import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

const markdown = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\n')
  .filter((file) => file && existsSync(join(root, file)));

/** Removes fenced code blocks, which may contain illustrative paths and links. */
function prose(source) {
  return source.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}

/** Returns GitHub-style heading anchors, numbering repeated headings. */
function anchors(source) {
  const seen = new Map();

  return new Set(
    [...prose(source).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map(
      ([, heading]) => {
        const slug = heading
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, '')
          .replace(/\s/g, '-');
        const count = seen.get(slug) ?? 0;
        seen.set(slug, count + 1);

        return count ? `${slug}-${count}` : slug;
      },
    ),
  );
}

test('relative Markdown links point to existing files and headings', () => {
  const broken = [];

  for (const file of markdown) {
    const source = readFileSync(join(root, file), 'utf8');
    const links = prose(source).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g);

    for (const [, link] of links) {
      if (/^[a-z][a-z+.-]*:/i.test(link)) continue;
      const [path, anchor] = link.split('#');
      const target = path
        ? join(dirname(join(root, file)), path)
        : join(root, file);

      if (!existsSync(target)) broken.push(`${file}: ${link}`);
      else if (anchor && target.endsWith('.md')) {
        if (!anchors(readFileSync(target, 'utf8')).has(anchor.toLowerCase()))
          broken.push(`${file}: ${link} (missing heading)`);
      }
    }
  }

  assert.deepEqual(broken, []);
});

/** Returns the paths Git ignores, such as local `.env` files and build output. */
function ignored(paths) {
  try {
    return new Set(
      execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
        cwd: root,
        encoding: 'utf8',
        // Directory patterns such as `dist/` only match with a trailing slash.
        input: paths.flatMap((path) => [path, `${path}/`]).join('\n'),
      })
        .split('\n')
        .map((path) => path.replace(/\/$/, '')),
    );
  } catch {
    return new Set();
  }
}

test('repository paths in inline code exist', () => {
  // Decision records keep the paths that applied when they were written.
  const references = markdown
    .filter((file) => !file.startsWith('docs/architecture/'))
    .flatMap((file) =>
      [
        ...prose(readFileSync(join(root, file), 'utf8')).matchAll(
          /`((?:apps|docs|packages|tooling)\/[^`\s]+)`/g,
        ),
      ]
        .map(([, path]) => path.replace(/[/:]+$/, ''))
        .filter((path) => !/[<>*{}$…]|\.\.\./.test(path))
        .map((path) => ({ file, path })),
    );
  const skipped = ignored(references.map(({ path }) => path));
  const missing = references
    .filter(({ path }) => !skipped.has(path) && !existsSync(join(root, path)))
    .map(({ file, path }) => `${file}: ${path}`);

  assert.deepEqual(missing, []);
});
