import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../../', import.meta.url));
const destination = resolve(
  process.env.LUMA_CODE_RUNTIME_DIR ?? join(root, '.luma/code-runtime'),
);
const platform = process.platform === 'darwin' ? 'macos' : process.platform;
const architecture =
  process.arch === 'arm64'
    ? 'aarch64'
    : process.arch === 'x64'
      ? 'x86_64'
      : process.arch;
const hashes = {
  'aarch64-macos': [
    '93dde14d4efb20046e5af75517ac6a7f2246f6c2370fecff8f68839d4a9028f7',
    '99e9ec6a8e8c98e119d137c08a921d2443d3b873c675a5571e1800f4451e6294',
  ],
  'aarch64-linux': [
    '7607529c40fed69c0f5d2a6fafa8c560b9e3c18ded31d8f1b13098afe49b7480',
    '826962f0e82354cf97d6e928ea36777872bbae76c626e326948e0367c4b55cb5',
  ],
  'x86_64-linux': [
    'c71f7e0d30a92e418f0d17db7c6d8f6664c1ad764340a1278678f4209deab534',
    'a68b122d48eb3dfc1b801d4e14c39271fde3638243d3272d206e376ac9189e39',
  ],
};
const expected = hashes[`${architecture}-${platform}`];
if (!expected)
  throw new Error(
    'Code runtime requires Linux on x64/arm64 or macOS on arm64.',
  );
const hash = (data) => createHash('sha256').update(data).digest('hex');

async function download(repository, version, name, digest) {
  const response = await fetch(
    `https://github.com/bytecodealliance/${repository}/releases/download/${version}/${name}`,
  );
  if (!response.ok) throw new Error(`Download failed: ${name}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (hash(data) !== digest) throw new Error(`Checksum mismatch: ${name}`);

  return data;
}

const staging = await mkdtemp(join(tmpdir(), 'luma-code-'));
try {
  const name = `wasmtime-v49.0.1-${architecture}-${platform}`;
  const archive = join(staging, 'wasmtime.tar.xz');
  await writeFile(
    archive,
    await download('wasmtime', 'v49.0.1', `${name}.tar.xz`, expected[0]),
  );
  execFileSync('tar', ['-xJf', archive, '-C', staging, `${name}/wasmtime`]);
  const javy = join(staging, 'javy');
  await writeFile(
    javy,
    gunzipSync(
      await download(
        'javy',
        'v9.1.0',
        `javy-${architecture === 'aarch64' ? 'arm' : architecture}-${platform}-v9.1.0.gz`,
        expected[1],
      ),
    ),
  );
  await chmod(javy, 0o755);
  const guest = join(staging, 'guest.wasm');
  execFileSync(
    javy,
    [
      'build',
      'guest.js',
      '-C',
      'dynamic=n',
      '-C',
      'deterministic=y',
      '-C',
      'source=omitted',
      '-o',
      guest,
    ],
    { timeout: 60000, cwd: join(root, 'tooling/code-runtime') },
  );
  const digest = hash(await readFile(guest));
  if (
    digest !==
    (platform === 'linux'
      ? architecture === 'x86_64'
        ? '904b98e156dafb36f16d051bbd75a6d529cbbbaa7e715350c1bf3fe7b06f6121'
        : '23d57b6a7b3f71997b388d288b840eae3e03c6b797efd0292018ecc6216b2d15'
      : 'a9ebcec73c5d2be040389b2748deb53fd699d2b6367a8fe60127e1874a564ca1')
  )
    throw new Error(`Guest build is not reproducible: ${digest}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [from, to] of [
    [join(staging, name, 'wasmtime'), 'wasmtime'],
    [guest, 'guest.wasm'],
  ]) {
    await writeFile(join(destination, `${to}.new`), await readFile(from), {
      mode: 0o700,
    });
    await rename(join(destination, `${to}.new`), join(destination, to));
  }
  await writeFile(
    join(destination, 'manifest.json'),
    JSON.stringify({
      wasmtime: hash(await readFile(join(destination, 'wasmtime'))),
      guest: digest,
    }) + '\n',
    { mode: 0o600 },
  );
  console.log(
    `Code runtime installed. Set LUMA_CODE_RUNTIME_DIR=${destination}`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
