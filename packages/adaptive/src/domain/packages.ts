import type { CustomFieldInput } from './fields.js';

/** Workspace choices stay separate from immutable package defaults. */
export interface PackageConfiguration {
  parameters: Record<string, string | number | boolean>;
  sharing: { scope: 'workspace' | 'roles'; roleIds: string[] };
}

export interface PackageResource {
  kind: 'field' | 'view' | 'workflow';
  key: string;
  id: string;
}

export interface OperationalPackage {
  id: string;
  version: string;
  name: { en: string; de: string };
  description: { en: string; de: string };
  permissions: string[];
  requirements: string[];
  parameters: {
    key: string;
    type: 'string' | 'number' | 'boolean';
    required: boolean;
    label: { en: string; de: string };
    default: string | number | boolean | null;
  }[];
  fields: { key: string; definition: CustomFieldInput }[];
  /** Validated by the view owner before any definitions are installed. */
  views: { key: string; definition: unknown }[];
  /** Published definitions remain inactive until normal reviewed activation. */
  workflows: { key: string; definition: unknown }[];
}

export interface PackageInstallation {
  packageId: string;
  version: string;
  revision: number;
  config: PackageConfiguration;
  resources: PackageResource[];
  removed: boolean;
}

export interface PackageReceipt {
  commandId: string;
  digest: string;
  result: PackageInstallation | null;
}
