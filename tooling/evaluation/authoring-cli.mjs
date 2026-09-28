import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { authoringModelProfile } from '@luma/platform';
import {
  createModelGateway,
  createObservability,
} from '@luma/platform/composition';

import { evaluateAuthoring } from './authoring.mjs';

const usage =
  'Usage: pnpm evaluate:authoring [corpus.json] [report.json]. Configure the EU authoring route first; see docs/model-gateway.md.';

try {
  const { readModelGatewayConfig } =
    await import('../../packages/config/dist/index.js');
  const settings = readModelGatewayConfig(process.env);
  const route = settings.routes[authoringModelProfile];
  if (
    !route ||
    route.adapter !== 'bedrock-eu' ||
    !route.zeroDataRetention ||
    !settings.bedrock
  )
    throw new Error(usage);
  const source = resolve(
    process.argv[2] ?? 'tooling/evaluation/fixtures/authoring-corpus.json',
  );
  const output = resolve(process.argv[3] ?? '.luma/evaluations/authoring.json');
  const observability = createObservability({
    environment: 'development',
    release: 'authoring-evaluation',
    sampleRate: 0,
    approvedModels: [route.model],
  });
  try {
    const report = await evaluateAuthoring(
      JSON.parse(await readFile(source, 'utf8')),
      { gateway: createModelGateway(settings, observability) },
    );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(`${output}.tmp`, output);
    for (const item of report.cases)
      console.log(
        `${item.valid ? 'VALID  ' : 'INVALID'} ${item.equivalent ? 'EQUIVALENT' : 'DIFFERENT '} ${item.id}${item.differences.length ? `: ${item.differences.join('; ')}` : ''}`,
      );
    console.log(
      `Valid drafts: ${(report.validDraftRate * 100).toFixed(0)}%. Equivalent to reference: ${(report.equivalenceRate * 100).toFixed(0)}%.\nModel: ${report.route?.model ?? 'none'}\nReport: ${output}`,
    );
  } finally {
    await observability.shutdown();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
