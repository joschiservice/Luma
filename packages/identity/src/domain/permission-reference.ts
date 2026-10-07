import { permissionCatalog, permissionGroups } from './permissions.js';
import { builtInRoles } from './roles.js';

/**
 * Renders the permission reference (keys, descriptions and built-in role matrix) as Markdown
 * from the catalog, so documentation follows the code.
 */
export function permissionReference() {
  const roles = Object.values(builtInRoles);
  const lines = [
    '# Permission reference',
    '',
    '<!-- Generated from packages/identity/src/domain/permissions.ts. Run `UPDATE_PERMISSION_REFERENCE=1 pnpm --filter @luma/identity test permission-reference` to refresh. -->',
    '',
    'Each role grants a set of these permissions. Owner and Admin also hold every permission of installed apps. Sensitive permissions change provider data, money, access or policy, or read personal data. See [ADR-009](architecture/009-permissions-and-roles.md).',
    '',
  ];
  for (const group of permissionGroups) {
    lines.push(`## ${group.label}`, '', group.description, '');
    lines.push(
      `| Permission | Key | Description | Sensitive | ${roles.map((role) => role.name).join(' | ')} |`,
      `| --- | --- | --- | --- | ${roles.map(() => '---').join(' | ')} |`,
    );
    for (const permission of permissionCatalog.filter(
      (item) => item.group === group.id,
    ))
      lines.push(
        `| ${permission.label} | \`${permission.key}\` | ${permission.description} | ${permission.consequential ? 'Yes' : ''} | ${roles
          .map((role) =>
            (role.permissions as readonly string[]).includes(permission.key)
              ? 'Yes'
              : '',
          )
          .join(' | ')} |`,
      );
    lines.push('');
  }

  return lines.join('\n');
}
