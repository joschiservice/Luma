/** Workload stages; each runs in its own AWS account. */
export type Stage = 'staging' | 'production';

export const stages: readonly Stage[] = ['staging', 'production'];

/** The AU cell's home region. */
export const cellRegion = 'ap-southeast-2';

/**
 * Regions that may process AU cell data. Melbourne is listed because Australian Bedrock
 * inference profiles route requests there.
 */
export const approvedRegions = ['ap-southeast-2', 'ap-southeast-4'];

/** Settings for one stage's AU cell. */
export interface CellSettings {
  readonly stage: Stage;
  /** Unset keeps the stacks environment-agnostic, which synthesis and tests need. */
  readonly account?: string;
  readonly instanceType: string;
  readonly dataVolumeGiB: number;
  /** The cell's public DNS zone, such as `staging.example.com`; unset uses sslip.io names. */
  readonly domain?: string;
  /** Receives budget and host alarms. */
  readonly alertEmail?: string;
  /** Recreates the data volume from this EBS snapshot, replacing the host with it. */
  readonly restoreSnapshotId?: string;
  /**
   * The host's Amazon Machine Image in the cell region. Deployable stages pin it so a stack
   * update never replaces the host with whatever image is newest; OS updates bump it.
   */
  readonly hostImage?: string;
  readonly monthlyBudgetUsd: number;
  readonly github: {
    readonly repository: string;
    readonly environment: string;
  };
}

const defaults: Record<
  Stage,
  Pick<CellSettings, 'instanceType' | 'dataVolumeGiB' | 'monthlyBudgetUsd'>
> = {
  staging: {
    instanceType: 't4g.medium',
    dataVolumeGiB: 30,
    monthlyBudgetUsd: 60,
  },
  production: {
    instanceType: 't4g.large',
    dataVolumeGiB: 50,
    monthlyBudgetUsd: 120,
  },
};

const repository = 'joschiservice/Luma';

/**
 * Reads one stage's settings. Account IDs, domains and alert addresses come from CDK context
 * (`-c luma:staging:account=123456789012`) so they stay out of source control. Throws on
 * malformed values, and when a stage with an account lacks a pinned host image or, for
 * production, an alert address.
 */
export function readCellSettings(
  stage: Stage,
  context: (key: string) => unknown,
): CellSettings {
  const text = (key: string) => {
    const value = context(key);
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new Error(`${key} must be a string`);

    return value;
  };
  const account = text(`luma:${stage}:account`);
  if (account !== undefined && !/^\d{12}$/.test(account))
    throw new Error(`luma:${stage}:account must be a 12-digit AWS account ID`);
  const domain = text(`luma:${stage}:domain`);
  if (
    domain !== undefined &&
    !/^(?=.{1,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      domain,
    )
  )
    throw new Error(`luma:${stage}:domain must be a lowercase DNS name`);
  const alertEmail =
    text(`luma:${stage}:alertEmail`) ?? text('luma:alertEmail');
  const restoreSnapshotId = text(`luma:${stage}:restoreSnapshot`);
  if (
    restoreSnapshotId !== undefined &&
    !/^snap-[0-9a-f]{8,17}$/.test(restoreSnapshotId)
  )
    throw new Error(`luma:${stage}:restoreSnapshot must be an EBS snapshot ID`);

  const hostImage = text(`luma:${stage}:hostImage`);
  if (hostImage !== undefined && !/^ami-[0-9a-f]{8,17}$/.test(hostImage))
    throw new Error(`luma:${stage}:hostImage must be an AMI ID`);
  // A stage with an account can be deployed; synthesis without one stays environment-agnostic.
  if (account !== undefined && hostImage === undefined)
    throw new Error(
      `luma:${stage}:hostImage is required once luma:${stage}:account is set`,
    );
  if (account !== undefined && stage === 'production' && !alertEmail)
    throw new Error(
      'luma:production:alertEmail or luma:alertEmail is required once luma:production:account is set',
    );

  return {
    stage,
    ...defaults[stage],
    ...(account ? { account } : {}),
    ...(domain ? { domain } : {}),
    ...(alertEmail ? { alertEmail } : {}),
    ...(restoreSnapshotId ? { restoreSnapshotId } : {}),
    ...(hostImage ? { hostImage } : {}),
    github: { repository, environment: stage },
  };
}
