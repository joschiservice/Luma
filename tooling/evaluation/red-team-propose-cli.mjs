import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { authoringModelProfile } from '@luma/platform';
import {
  createModelGateway,
  createObservability,
} from '@luma/platform/composition';

import { proposeRedTeamScenarios } from './red-team.mjs';

const usage =
  'Usage: pnpm propose:red-team <workspace-id> <corpus.json> <proposals.json>. Requires the workspace release and an EU zero-retention authoring route.';

try {
  const [tenantId, source, destination, extra] = process.argv.slice(2);
  if (
    !tenantId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      tenantId,
    ) ||
    !source ||
    !destination ||
    extra
  )
    throw new Error(usage);
  const { readModelGatewayConfig, readObservabilityConfig } =
    await import('../../packages/config/dist/index.js');
  const models = readModelGatewayConfig(process.env);
  const route = models.routes[authoringModelProfile];
  const observability = createObservability({
    ...readObservabilityConfig(process.env),
    sampleRate: 0,
    approvedModels: route ? [route.model] : [],
  });
  const observation = observability.request(randomUUID());
  try {
    // This maintenance command is run by a deployment operator for an explicit workspace.
    // No customer data is loaded and the release check grants no execution authority.
    const trace = observability.forTenant(observation.context, tenantId, 'EU');
    const enabled = await observability.flag(
      trace,
      'workflow-red-teaming',
      false,
    );
    if (!enabled) throw new Error('Workflow red teaming is disabled.');
    if (
      !route ||
      route.adapter !== 'bedrock-eu' ||
      !route.zeroDataRetention ||
      !models.bedrock
    )
      throw new Error('Configure the EU zero-retention authoring route first.');
    const input = resolve(source);
    if ((await stat(input)).size > 1024 * 1024)
      throw new Error('Scenario catalogue exceeds 1 MiB.');
    const generated = await proposeRedTeamScenarios(
      JSON.parse(await readFile(input, 'utf8')),
      { gateway: createModelGateway(models, observability), enabled, trace },
    );
    const proposals = {
      ...generated,
      release: {
        flag: 'workflow-red-teaming',
        tenantId,
        evaluatedAt: new Date().toISOString(),
      },
    };
    const output = resolve(destination);
    const temporary = `${output}.${randomUUID()}.tmp`;
    await mkdir(dirname(output), { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(proposals, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, output);
    } finally {
      await rm(temporary, { force: true });
    }
    console.log(
      `Saved ${proposals.specs.length} scenario proposals: ${output}`,
    );
  } finally {
    observation.end();
    await observability.shutdown();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : usage);
  process.exitCode = 1;
}
