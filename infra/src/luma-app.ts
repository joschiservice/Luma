import { type App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

import { FoundationStack } from './foundation-stack.js';
import { LiteCellStack } from './lite-cell-stack.js';
import { OrganizationStack } from './organization-stack.js';
import { cellRegion, readCellSettings, stages } from './settings.js';
import {
  snapshotCopyRegion,
  SnapshotCopyStack,
} from './snapshot-copy-stack.js';

/**
 * Adds every Luma stack to the app: the organization guardrails for the management account
 * and, per stage, the foundation, the Lite cell and the Melbourne snapshot copy vault for that
 * stage's account. Once both stage accounts are set, staging promotes its server images to
 * production. The cdk-nag AWS Solutions checks run on synthesis and fail it on any
 * unacknowledged finding.
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

  const settingsByStage = stages.map((stage) =>
    readCellSettings(stage, context),
  );
  const [staging, production] = settingsByStage;
  // Production deploys only images promoted from staging, so it needs staging's account.
  if (production?.account && !staging?.account)
    throw new Error(
      'luma:staging:account is required once luma:production:account is set',
    );
  const promotion =
    staging?.account && production?.account
      ? { staging: staging.account, production: production.account }
      : undefined;

  const cells = settingsByStage.map((settings) => {
    const { stage } = settings;
    const env = {
      region: cellRegion,
      ...(settings.account ? { account: settings.account } : {}),
    };
    const name = stage[0]!.toUpperCase() + stage.slice(1);
    const foundation = new FoundationStack(app, `LumaFoundation${name}`, {
      env,
      settings,
      ...(promotion ? { promotion } : {}),
    });
    const snapshotCopies = new SnapshotCopyStack(
      app,
      `LumaSnapshotCopies${name}`,
      {
        env: { ...env, region: snapshotCopyRegion },
        stage,
      },
    );
    const cell = new LiteCellStack(app, `LumaLiteCell${name}`, {
      env,
      settings,
      foundation,
    });
    // The cell's backup plan copies into the vault by name, so the vault must exist first.
    cell.addStackDependency(snapshotCopies);

    return { foundation, cell, snapshotCopies };
  });

  Tags.of(app).add('luma:managed-by', 'infra');
  Validations.of(app).addPlugins(
    new AwsSolutionsChecks(app, { verbose: true }),
  );

  return { organization, cells };
}
