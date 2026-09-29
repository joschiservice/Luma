import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fail, root, run } from '../dev/process.mjs';

const version = '1.20.0';
const releases = {
  'darwin-arm64': [
    'aarch64-apple-darwin',
    '8ee7067016620447c9d2d6234ec9a4680f958b7ad983549b56334668f63075b5',
  ],
  'darwin-x64': [
    'x86_64-apple-darwin',
    'f58d0b90993fadfa122a351428c469ce24afef3865f027f0e6e86f0830d088f1',
  ],
  'linux-arm64': [
    'aarch64-unknown-linux-gnu',
    '90875cb1db7a1d797c311174d061728361e58fc70e3b62262a00635ac3b1997c',
  ],
  'linux-x64': [
    'x86_64-unknown-linux-gnu',
    '63ad53934062118f5b0be11785e0bb1603d4b91667d1921f2fd8df9a8712040a',
  ],
};

let staging;
try {
  const release = releases[`${process.platform}-${process.arch}`];
  if (!release)
    throw new Error(
      'Hyperfine setup supports macOS and Linux on arm64 or x64.',
    );
  const [target, checksum] = release;
  const name = `hyperfine-v${version}-${target}`;
  const response = await fetch(
    `https://github.com/sharkdp/hyperfine/releases/download/v${version}/${name}.tar.gz`,
  );
  if (!response.ok)
    throw new Error(`Hyperfine download failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(data).digest('hex') !== checksum) {
    throw new Error('Hyperfine archive checksum mismatch.');
  }
  staging = await mkdtemp(join(tmpdir(), 'luma-hyperfine-'));
  const archive = join(staging, 'hyperfine.tar.gz');
  await writeFile(archive, data);
  await run('tar', ['-xzf', archive, '-C', staging, `${name}/hyperfine`]);
  const directory = join(root, '.luma/tools');
  await mkdir(directory, { recursive: true });
  const binary = join(directory, 'hyperfine');
  await copyFile(join(staging, name, 'hyperfine'), binary);
  await chmod(binary, 0o755);
  console.log(await run(binary, ['--version'], { capture: true }));
} catch (error) {
  fail(error);
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
}
