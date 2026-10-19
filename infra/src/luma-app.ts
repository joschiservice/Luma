import { type App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

import { FoundationStack } from './foundation-stack.js';
import { LiteCellStack } from './lite-cell-stack.js';
import { OrganizationStack } from './organization-stack.js';
import { cellRegion, readCellSettings, stages } from './settings.js';

/**
 * Adds every Luma stack to the app: the organization guardrails for the management account
 * and, per stage, the foundation and Lite cell for that stage's account. The cdk-nag
 * AWS Solutions checks run on synthesis and fail it on any unacknowledged finding.
 */
export function buildLumaApp(app: App) {
  const context = (key: string) => app.node.tryGetContext(key) as unknown;
  const targets = context('luma:organization:targets');
  if (targets !== undefined && typeof targets !== 'string')
    throw new Error(
      'luma:organization:targets must be a comma-separated string',
    );

  // Organizations APIs are served from us-east-1.
  const organization = new OrganizationStack(app, 'LumaOrganization', {
    env: { region: 'us-east-1' },
    targetIds: (targets ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  });

  const cells = stages.map((stage) => {
    const settings = readCellSettings(stage, context);
    const env = {
      region: cellRegion,
      ...(settings.account ? { account: settings.account } : {}),
    };
    const name = stage[0]!.toUpperCase() + stage.slice(1);
    const foundation = new FoundationStack(app, `LumaFoundation${name}`, {
      env,
      settings,
    });
    const cell = new LiteCellStack(app, `LumaLiteCell${name}`, {
      env,
      settings,
      foundation,
    });

    return { foundation, cell };
  });

  Tags.of(app).add('luma:managed-by', 'infra');
  Validations.of(app).addPlugins(
    new AwsSolutionsChecks(app, { verbose: true }),
  );

  return { organization, cells };
}
