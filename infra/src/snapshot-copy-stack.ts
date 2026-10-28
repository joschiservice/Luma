import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import type { Construct } from 'constructs';

/** The approved second Australian region that holds copies of the cell's volume snapshots. */
export const snapshotCopyRegion = 'ap-southeast-4';

export interface SnapshotCopyStackProps extends StackProps {
  readonly stage: string;
}

/**
 * The vault in Melbourne that receives copies of the Lite cell's daily data volume snapshots,
 * so a Sydney regional outage does not take every backup with it. The cell stack's backup plan
 * copies into it by name; the vault is retained when the stack is deleted.
 */
export class SnapshotCopyStack extends Stack {
  constructor(scope: Construct, id: string, props: SnapshotCopyStackProps) {
    super(scope, id, props);

    new backup.BackupVault(this, 'SnapshotCopies', {
      backupVaultName: snapshotCopyVaultName(props.stage),
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}

/** The copy vault's name, derived so the cell stack can address it without a reference. */
export function snapshotCopyVaultName(stage: string) {
  return `luma-${stage}-snapshot-copies`;
}
