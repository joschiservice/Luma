import './adaptive.css';

import {
  type AdaptivePackageConfig,
  adaptivePackageSummarySchema,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';

import { Pending } from '../../kit/identity/common';
import { NoAccess, usePermissions } from '../../kit/identity/permissions';
import { rolesOptions } from '../../kit/settings/roles-data';
import { adaptiveApi, adaptiveAvailabilityOptions, adaptiveKey } from './data';
import { adaptiveLabel } from './presentation';

type Package = z.infer<typeof adaptivePackageSummarySchema>;

/** Offers versioned business configurations with explicit prerequisites and reviewed installation. */
export function PackagesPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const { can } = usePermissions(organizationId);
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const list = useQuery({
    queryKey: [...adaptiveKey(organizationId), 'packages'],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptivePackages.list(
        { params: { organizationId } },
        { signal },
      ),
    enabled: !!availability.data?.packages && can('adaptive.packages.manage'),
  });
  const [selected, setSelected] = useState<Package | null>(null);
  if (!can('adaptive.packages.manage'))
    return (
      <NoAccess
        organizationId={organizationId}
        area={m.adaptive_packages_title()}
        permission="adaptive.packages.manage"
      />
    );
  if (availability.isPending) return <Pending />;
  if (!availability.data?.packages)
    return <Alert>{m.adaptive_unavailable()}</Alert>;

  return (
    <div className="adaptive-workspace">
      <PageTitle title={m.adaptive_packages_title()} />
      <p>{m.adaptive_packages_description()}</p>
      {list.isPending ? (
        <Pending />
      ) : list.isError ? (
        <Alert tone="warning">
          {m.adaptive_load_failed()}
          <Button variant="outline" onClick={() => void list.refetch()}>
            {m.adaptive_retry()}
          </Button>
        </Alert>
      ) : (
        <div className="adaptive-library">
          {list.data?.items.map((item) => (
            <Card key={item.id}>
              <CardHeader>
                <div className="adaptive-view-heading">
                  <CardTitle as="h2">{adaptiveLabel(item.name)}</CardTitle>
                  <Badge>
                    {item.installed ? m.adaptive_installed() : item.version}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p>{adaptiveLabel(item.description)}</p>
                <Button variant="outline" onClick={() => setSelected(item)}>
                  {m.adaptive_package_preview()}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {selected ? (
        <PackageReview
          key={selected.id}
          organizationId={organizationId}
          item={selected}
          close={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function PackageReview({
  organizationId,
  item,
  close,
}: {
  organizationId: string;
  item: Package;
  close: () => void;
}) {
  const client = useQueryClient();
  const roles = useQuery(rolesOptions(organizationId));
  const [config, setConfig] = useState<AdaptivePackageConfig>(
    item.installed?.config ??
      item.retainedConfig ?? {
        parameters: Object.fromEntries(
          item.parameters.flatMap((parameter) =>
            parameter.default === null
              ? []
              : [[parameter.key, parameter.default]],
          ),
        ),
        sharing: { scope: 'workspace', roleIds: [] },
      },
  );
  const [commandId] = useState(() => crypto.randomUUID());
  const preview = useMutation({
    mutationFn: () =>
      adaptiveApi.adaptivePackages.preview({
        params: { organizationId, packageId: item.id },
        body: { version: item.version, config },
      }),
  });
  const change = (parameters: AdaptivePackageConfig['parameters']) => {
    setConfig({ ...config, parameters });
    preview.reset();
  };
  const mutate = useMutation({
    mutationFn: async (operation: 'install' | 'uninstall'): Promise<unknown> =>
      operation === 'uninstall' && item.installed
        ? adaptiveApi.adaptivePackages.uninstall({
            params: { organizationId, packageId: item.id },
            body: { commandId, revision: item.installed.revision },
          })
        : adaptiveApi.adaptivePackages.install({
            params: { organizationId, packageId: item.id },
            body: {
              commandId,
              version: item.version,
              config,
              reviewDigest: preview.data?.reviewDigest ?? '',
            },
          }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: adaptiveKey(organizationId) });
      close();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !mutate.isPending) close();
      }}
    >
      <DialogContent className="adaptive-dialog">
        <DialogHeader>
          <DialogTitle>{adaptiveLabel(item.name)}</DialogTitle>
          <DialogDescription>
            {adaptiveLabel(item.description)}
          </DialogDescription>
        </DialogHeader>
        <p>{m.adaptive_package_inactive()}</p>
        <section>
          <h3>{m.adaptive_permissions()}</h3>
          <ul>
            {item.permissions.map((permission) => (
              <li key={permission}>{permission}</li>
            ))}
          </ul>
          {item.requirements.map((requirement) => (
            <p key={requirement}>{requirement}</p>
          ))}
        </section>
        {item.parameters.length ? (
          <section className="adaptive-editor-form">
            <h3>{m.adaptive_parameters()}</h3>
            {item.parameters.map((parameter) => (
              <Field key={parameter.key}>
                <FieldLabel htmlFor={`package-${parameter.key}`}>
                  {adaptiveLabel(parameter.label)}
                </FieldLabel>
                {parameter.type === 'boolean' ? (
                  <label className="adaptive-check">
                    <input
                      id={`package-${parameter.key}`}
                      type="checkbox"
                      checked={config.parameters[parameter.key] === true}
                      onChange={(event) =>
                        change({
                          ...config.parameters,
                          [parameter.key]: event.target.checked,
                        })
                      }
                    />
                    {adaptiveLabel(parameter.label)}
                  </label>
                ) : (
                  <Input
                    id={`package-${parameter.key}`}
                    type={parameter.type === 'number' ? 'number' : 'text'}
                    required={parameter.required}
                    value={String(config.parameters[parameter.key] ?? '')}
                    onChange={(event) =>
                      change({
                        ...config.parameters,
                        [parameter.key]:
                          parameter.type === 'number'
                            ? Number(event.target.value)
                            : event.target.value,
                      })
                    }
                  />
                )}
              </Field>
            ))}
          </section>
        ) : null}
        {item.retainedConfig ? (
          <Alert>{m.adaptive_package_retained()}</Alert>
        ) : null}
        <Field>
          <FieldLabel>{m.adaptive_sharing()}</FieldLabel>
          <Select
            aria-label={m.adaptive_sharing()}
            value={config.sharing.scope}
            options={[
              { value: 'workspace', label: m.adaptive_workspace() },
              { value: 'roles', label: m.adaptive_roles() },
            ]}
            onValueChange={(scope) => {
              if (scope) {
                setConfig({ ...config, sharing: { scope, roleIds: [] } });
                preview.reset();
              }
            }}
          />
        </Field>
        {config.sharing.scope === 'roles' ? (
          <div className="adaptive-checks">
            {roles.data?.roles.map((role) => (
              <label className="adaptive-check" key={role.id}>
                <input
                  type="checkbox"
                  checked={config.sharing.roleIds.includes(role.id)}
                  onChange={(event) => {
                    setConfig({
                      ...config,
                      sharing: {
                        ...config.sharing,
                        roleIds: event.target.checked
                          ? [...config.sharing.roleIds, role.id]
                          : config.sharing.roleIds.filter(
                              (id) => id !== role.id,
                            ),
                      },
                    });
                    preview.reset();
                  }}
                />
                {role.name}
              </label>
            ))}
          </div>
        ) : null}
        <p>{m.adaptive_sharing_note()}</p>
        <Button
          variant="outline"
          disabled={preview.isPending}
          onClick={() => preview.mutate()}
        >
          {m.adaptive_package_preview()}
        </Button>
        {preview.isError || mutate.isError ? (
          <Alert tone="warning" role="alert">
            {m.adaptive_operation_failed()}
          </Alert>
        ) : null}
        {preview.data ? (
          <section className="adaptive-package-resources">
            <h3>{m.adaptive_package_resources()}</h3>
            {preview.data.missing.map((missing) => (
              <Alert key={missing} tone="warning">
                {missing}
              </Alert>
            ))}
            {preview.data.additions.map((addition) => (
              <p key={`${addition.kind}:${addition.key}`}>
                <Badge>{addition.kind}</Badge> {addition.label}
              </p>
            ))}
            <Button
              disabled={!preview.data.canInstall || mutate.isPending}
              onClick={() => mutate.mutate('install')}
            >
              {m.adaptive_install()}
            </Button>
          </section>
        ) : null}
        {item.installed ? (
          <Button
            variant="outline"
            disabled={mutate.isPending}
            onClick={() => mutate.mutate('uninstall')}
          >
            {m.adaptive_uninstall()}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
