import type { Permission, TenantContext } from '@luma/identity';
import {
  isPermission,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import {
  conflict,
  forbidden,
  invalid,
  notFound,
  ServiceError,
  unavailable,
} from '@luma/platform';

import type {
  OperationalPackage,
  PackageConfiguration,
  PackageInstallation,
  PackageReceipt,
  PackageResource,
} from '../domain/packages.js';

/** Transactional owner operations retain each owner's validation and audit behavior. */
interface PackageTransaction {
  installation(packageId: string): Promise<PackageInstallation | null>;
  save(installation: PackageInstallation): Promise<void>;
  receipt(commandId: string): Promise<PackageReceipt | null>;
  recordReceipt(receipt: PackageReceipt): Promise<void>;
  event(
    context: TenantContext,
    commandId: string,
    before: PackageInstallation | null,
    after: PackageInstallation | null,
  ): Promise<void>;
  install(
    context: TenantContext,
    definition: OperationalPackage,
    prior: PackageInstallation | null,
  ): Promise<PackageResource[]>;
  remove(
    context: TenantContext,
    installation: PackageInstallation,
  ): Promise<void>;
}

export interface PackageStore {
  transaction<T>(
    context: TenantContext,
    work: (tx: PackageTransaction) => Promise<T>,
  ): Promise<T>;
  get(context: TenantContext, id: string): Promise<PackageInstallation | null>;
}

/** Reviews bounded package definitions and applies all additions atomically; never grants access. */
export function createOperationalPackages(deps: {
  definitions: OperationalPackage[];
  store: PackageStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  released(context: TenantContext): Promise<boolean>;
  missing(
    context: TenantContext,
    definition: OperationalPackage,
    config: PackageConfiguration,
  ): Promise<string[]>;
  /** Resolves parameter references and validates every owner definition before starting writes. */
  configure(
    context: TenantContext,
    definition: OperationalPackage,
    config: PackageConfiguration,
  ): Promise<OperationalPackage>;
  parseConfig(input: unknown): PackageConfiguration;
  digest(value: unknown): string;
}) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');
    requirePermission(fresh, 'adaptive.packages.manage');
    if (write) requireChangesAllowed(fresh);
    if (!(await deps.released(fresh)))
      throw unavailable(
        'Operational packages are not enabled for this workspace.',
      );

    return fresh;
  }

  function definition(id: string, version: string) {
    const found = deps.definitions.find(
      (d) => d.id === id && d.version === version,
    );
    if (!found) throw notFound('Package version not found.');

    return found;
  }

  function summary(d: OperationalPackage, i: PackageInstallation | null) {
    return {
      ...d,
      retainedConfig: i?.removed ? i.config : null,
      installed:
        i && !i.removed
          ? {
              version: i.version,
              revision: i.revision,
              config: i.config,
              resources: i.resources,
            }
          : null,
    };
  }

  async function prepare(
    context: TenantContext,
    id: string,
    request: { version: string; config: PackageConfiguration },
    prior?: PackageInstallation | null,
  ) {
    const d = definition(id, request.version);
    const config = deps.parseConfig(request.config);
    if (
      Object.keys(config.parameters).some(
        (key) => !d.parameters.some((p) => p.key === key),
      )
    )
      throw invalid('The package does not define this parameter.');
    for (const p of d.parameters) {
      const value = config.parameters[p.key];
      if (
        (value === undefined && p.required) ||
        (value !== undefined && typeof value !== p.type)
      )
        throw invalid(`Configure the ${p.key} parameter as ${p.type}.`);
    }
    for (const permission of d.permissions) {
      if (!isPermission(permission))
        throw invalid('A required package permission is unavailable.');
      requirePermission(context, permission as Permission);
    }
    const configured = await deps.configure(context, d, config);
    const missing = await deps.missing(context, configured, config);
    const installed =
      prior === undefined ? await deps.store.get(context, id) : prior;
    const reviewDigest = deps.digest({
      tenant: context.tenantId,
      actor: context.actor.id,
      definition: configured,
      config,
      revision: installed?.revision ?? 0,
      missing,
    });

    return { d, configured, config, installed, missing, reviewDigest };
  }

  return {
    /** Lists definitions once per latest version and retains each workspace's configuration. */
    async list(context: TenantContext) {
      context = await authorize(context);
      const latest = new Map<string, OperationalPackage>();
      for (const d of deps.definitions) {
        const prev = latest.get(d.id);
        if (
          !prev ||
          d.version.localeCompare(prev.version, undefined, { numeric: true }) >
            0
        )
          latest.set(d.id, d);
      }

      return {
        items: await Promise.all(
          [...latest.values()].map(async (d) =>
            summary(d, await deps.store.get(context, d.id)),
          ),
        ),
      };
    },
    /** Describes additions and requirements; workflow activation and permission grants remain separate. */
    async preview(
      context: TenantContext,
      id: string,
      request: { version: string; config: PackageConfiguration },
    ) {
      context = await authorize(context);
      const p = await prepare(context, id, request);

      return {
        package: summary(p.d, p.installed),
        reviewDigest: p.reviewDigest,
        canInstall: p.missing.length === 0,
        missing: p.missing,
        additions: [
          ...p.configured.fields.map((f) => ({
            kind: 'field' as const,
            key: f.key,
            label: f.definition.label.en,
          })),
          ...p.configured.views.map((v) => ({
            kind: 'view' as const,
            key: v.key,
            label: v.key,
          })),
          ...p.configured.workflows.map((w) => ({
            kind: 'workflow' as const,
            key: w.key,
            label: w.key,
          })),
        ],
        workflowsActivate: false as const,
        permissionsGranted: [],
      };
    },
    /** Exact retries return a retained receipt, and missing requirements create no partial package. */
    async install(
      context: TenantContext,
      id: string,
      request: {
        version: string;
        config: PackageConfiguration;
        commandId: string;
        reviewDigest: string;
      },
    ) {
      context = await authorize(context, true);
      const commandDigest = deps.digest({
        tenant: context.tenantId,
        actor: context.actor.id,
        id,
        request,
      });

      return deps.store.transaction(context, async (tx) => {
        const receipt = await tx.receipt(request.commandId);
        if (receipt) {
          if (receipt.digest !== commandDigest)
            throw conflict(
              'This command ID was used for a different package change.',
            );

          return summary(definition(id, request.version), receipt.result);
        }
        const prior = await tx.installation(id);
        const p = await prepare(context, id, request, prior);
        if (p.reviewDigest !== request.reviewDigest)
          throw conflict('The package review changed. Preview it again.');
        if (p.missing.length)
          throw new ServiceError(409, 'NOT_READY', p.missing.join(' '));
        // Same version and configuration are a no-op even under a new command ID.
        if (
          prior &&
          !prior.removed &&
          prior.version === request.version &&
          deps.digest(prior.config) === deps.digest(p.config)
        ) {
          await tx.recordReceipt({
            commandId: request.commandId,
            digest: commandDigest,
            result: prior,
          });

          return summary(p.d, prior);
        }
        if (prior && deps.digest(prior.config) !== deps.digest(p.config))
          throw conflict(
            'Keep the installed workspace configuration when applying a new package version. Edit local resources separately.',
          );
        const resources = await tx.install(context, p.configured, prior);
        const after = {
          packageId: id,
          version: request.version,
          revision: (prior?.revision ?? 0) + 1,
          config: p.config,
          resources,
          removed: false,
        };
        await tx.save(after);
        await tx.event(context, request.commandId, prior, after);
        await tx.recordReceipt({
          commandId: request.commandId,
          digest: commandDigest,
          result: after,
        });

        return summary(p.d, after);
      });
    },
    /** Archives only package-added definitions, preserving records, values, runs and audit history. */
    async uninstall(
      context: TenantContext,
      id: string,
      request: { commandId: string; revision: number },
    ) {
      context = await authorize(context, true);
      const digest = deps.digest({
        tenant: context.tenantId,
        actor: context.actor.id,
        id,
        request,
        kind: 'uninstall',
      });

      return deps.store.transaction(context, async (tx) => {
        const receipt = await tx.receipt(request.commandId);
        if (receipt) {
          if (receipt.digest !== digest)
            throw conflict('This command ID was used for another change.');

          return { removed: true as const };
        }
        const prior = await tx.installation(id);
        if (!prior || prior.removed)
          throw notFound('Package installation not found.');
        if (prior.revision !== request.revision)
          throw conflict(
            'The installation changed. Reload before removing it.',
          );
        await tx.remove(context, prior);
        const after = { ...prior, removed: true, revision: prior.revision + 1 };
        await tx.save(after);
        await tx.event(context, request.commandId, prior, after);
        await tx.recordReceipt({
          commandId: request.commandId,
          digest,
          result: after,
        });

        return { removed: true as const };
      });
    },
  };
}

export type OperationalPackages = ReturnType<typeof createOperationalPackages>;
