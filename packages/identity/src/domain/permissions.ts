/** A section of the permission list, shown as one group in role editors and references. */
export interface PermissionGroup {
  id: string;
  label: string;
  description: string;
}

/** A capability a role can grant. Keys are stable; labels and descriptions are for people. */
export interface PermissionDefinition {
  key: string;
  group: string;
  label: string;
  description: string;
  /** Grants changes to provider data, money, access or policy, or reads personal data. */
  consequential: boolean;
  /** ISO date the permission was added; role editors mark later additions as new. */
  introduced: string;
}

export const permissionGroups = [
  {
    id: 'workspace',
    label: 'Workspace',
    description: 'Shared workspace details and approval policy.',
  },
  {
    id: 'access',
    label: 'Team and access',
    description: 'Who belongs to the workspace and what each role can do.',
  },
  {
    id: 'records',
    label: 'Commerce records',
    description: 'Imported orders, stock, products, customers and returns.',
  },
  {
    id: 'issues',
    label: 'Issues and decisions',
    description:
      'Operational issues, their evidence and the decisions they need.',
  },
  {
    id: 'actions',
    label: 'Actions',
    description: 'Changes Luma makes in connected systems.',
  },
  {
    id: 'workflows',
    label: 'Workflows',
    description: 'Automated processes, their drafts, versions and triggers.',
  },
  {
    id: 'procurement',
    label: 'Procurement',
    description: 'Suppliers, purchase orders and replenishment.',
  },
  {
    id: 'connections',
    label: 'Connections and apps',
    description: 'Connected systems, imports and installed apps.',
  },
  {
    id: 'assistant',
    label: 'Assistant',
    description: 'Ask Luma questions about workspace data.',
  },
  {
    id: 'activity',
    label: 'Activity',
    description: 'The record of what people and Luma did.',
  },
] as const satisfies readonly PermissionGroup[];

const introduced = '2026-10-06';

/**
 * Every core permission. Add new capabilities here: built-in Owner and Admin receive them
 * through code, custom roles only when someone grants them.
 */
export const permissionCatalog = [
  {
    key: 'workspace.settings.manage',
    group: 'workspace',
    label: 'Edit workspace settings',
    description: 'Change the workspace name and display timezone.',
    consequential: false,
    introduced,
  },
  {
    key: 'workspace.approval_policy.manage',
    group: 'workspace',
    label: 'Manage approval policy',
    description:
      'Decide whether every permitted change needs independent approval.',
    consequential: true,
    introduced,
  },
  {
    key: 'members.manage',
    group: 'access',
    label: 'Manage team members',
    description:
      'Invite people, change their role and remove their access. People can only assign roles whose permissions they hold.',
    consequential: true,
    introduced,
  },
  {
    key: 'roles.manage',
    group: 'access',
    label: 'Manage roles',
    description:
      'Create, edit and archive custom roles, and read their change history. People can only grant permissions they hold.',
    consequential: true,
    introduced,
  },
  {
    key: 'orders.read',
    group: 'records',
    label: 'View orders',
    description: 'See orders, their lines, payments and provider links.',
    consequential: false,
    introduced,
  },
  {
    key: 'fulfillment.read',
    group: 'records',
    label: 'View fulfillment',
    description: 'See shipments, carriers and fulfillment progress.',
    consequential: false,
    introduced,
  },
  {
    key: 'inventory.read',
    group: 'records',
    label: 'View inventory',
    description: 'See stock positions, locations and stock history.',
    consequential: false,
    introduced,
  },
  {
    key: 'products.read',
    group: 'records',
    label: 'View products',
    description: 'See the product catalog and SKU comparisons.',
    consequential: false,
    introduced,
  },
  {
    key: 'customers.read',
    group: 'records',
    label: 'View customers',
    description:
      'See customer profiles, including names, email addresses and postal addresses.',
    consequential: true,
    introduced,
  },
  {
    key: 'returns.read',
    group: 'records',
    label: 'View returns',
    description: 'See returns, refunds and money returned.',
    consequential: false,
    introduced,
  },
  {
    key: 'insights.read',
    group: 'records',
    label: 'View insights',
    description: 'See operational metrics, rule charts and import coverage.',
    consequential: false,
    introduced,
  },
  {
    key: 'issues.read',
    group: 'issues',
    label: 'View issues',
    description: 'See issues, their evidence, diagnoses and proposed actions.',
    consequential: false,
    introduced,
  },
  {
    key: 'issues.manage',
    group: 'issues',
    label: 'Work on issues',
    description:
      'Verify, escalate and resolve issues, refresh their evidence and record what was learned.',
    consequential: false,
    introduced,
  },
  {
    key: 'decisions.self_assign',
    group: 'issues',
    label: 'Take decisions',
    description: 'Take unassigned decisions in Needs you and release your own.',
    consequential: false,
    introduced,
  },
  {
    key: 'decisions.assign',
    group: 'issues',
    label: 'Assign decisions',
    description: 'Assign or reassign any decision to a teammate.',
    consequential: false,
    introduced,
  },
  {
    key: 'decisions.respond',
    group: 'issues',
    label: 'Approve or reject changes',
    description:
      'Respond to approval requests. The approver must differ from the person who proposed the change.',
    consequential: true,
    introduced,
  },
  {
    key: 'actions.propose',
    group: 'actions',
    label: 'Propose actions',
    description:
      'Ask Luma to prepare changes in connected systems, subject to policy and approval.',
    consequential: true,
    introduced,
  },
  {
    key: 'actions.execute',
    group: 'actions',
    label: 'Run actions',
    description:
      'Run permitted or approved changes in connected systems. Some actions need their own app permission instead.',
    consequential: true,
    introduced,
  },
  {
    key: 'workflows.read',
    group: 'workflows',
    label: 'View workflows',
    description: 'See workflows, versions, runs and their evidence.',
    consequential: false,
    introduced,
  },
  {
    key: 'workflows.author',
    group: 'workflows',
    label: 'Author workflows',
    description:
      'Create and edit drafts, generate drafts with Luma and run draft tests.',
    consequential: false,
    introduced,
  },
  {
    key: 'workflows.publish',
    group: 'workflows',
    label: 'Publish and enable workflows',
    description: 'Publish workflow versions and turn workflows on or off.',
    consequential: true,
    introduced,
  },
  {
    key: 'workflows.triggers.manage',
    group: 'workflows',
    label: 'Manage workflow triggers',
    description: 'Create, change and pause schedules and event triggers.',
    consequential: true,
    introduced,
  },
  {
    key: 'playbooks.activate',
    group: 'workflows',
    label: 'Activate playbooks',
    description:
      'Activate resolution playbooks and review their shadow-mode results.',
    consequential: true,
    introduced,
  },
  {
    key: 'procurement.read',
    group: 'procurement',
    label: 'View procurement',
    description:
      'See suppliers, purchase orders, commitments and replenishment.',
    consequential: false,
    introduced,
  },
  {
    key: 'procurement.manage',
    group: 'procurement',
    label: 'Manage procurement',
    description:
      'Edit suppliers and purchase orders, review commitments and configure replenishment.',
    consequential: true,
    introduced,
  },
  {
    key: 'connections.manage',
    group: 'connections',
    label: 'Manage connections',
    description: 'Connect, reauthorize and disconnect systems.',
    consequential: true,
    introduced,
  },
  {
    key: 'sync.manage',
    group: 'connections',
    label: 'Manage imports',
    description:
      'Start, pause and repair imports, and review links between imported records.',
    consequential: false,
    introduced,
  },
  {
    key: 'apps.manage',
    group: 'connections',
    label: 'Manage apps',
    description:
      'Install, upgrade and uninstall apps, and grant the access they request.',
    consequential: true,
    introduced,
  },
  {
    key: 'assistant.use',
    group: 'assistant',
    label: 'Use Ask Luma',
    description:
      'Ask questions about workspace data. Answers only include data this role can see.',
    consequential: false,
    introduced,
  },
  {
    key: 'activity.read',
    group: 'activity',
    label: 'View activity',
    description: 'See the workspace activity log.',
    consequential: false,
    introduced,
  },
  {
    key: 'activity.read_restricted',
    group: 'activity',
    label: 'View restricted activity',
    description:
      'See access changes, actor details and restricted activity entries.',
    consequential: true,
    introduced,
  },
] as const satisfies readonly (PermissionDefinition & {
  group: (typeof permissionGroups)[number]['id'];
})[];

/** A core permission key. Misspelled keys fail type-checking. */
export type Permission = (typeof permissionCatalog)[number]['key'];

/** An app-owned permission key, namespaced as `<appId>:<name>`. */
export type AppPermission = `${string}:${string}`;

const corePermissions: ReadonlySet<string> = new Set(
  permissionCatalog.map((permission) => permission.key),
);

/** Reports whether a value is a core permission key. */
export function isPermission(value: string): value is Permission {
  return corePermissions.has(value);
}

const appPermissionPattern =
  /^([a-z][a-z0-9-]{0,39}):([a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*)$/;

/** Returns the app ID of a well-formed `<appId>:<name>` key, or null. */
export function appPermissionOwner(value: string): string | null {
  const match = appPermissionPattern.exec(value);

  return match && value.length <= 120 ? match[1]! : null;
}

/** Reports whether a value is a well-formed app permission key. */
export function isAppPermission(value: string): value is AppPermission {
  return appPermissionOwner(value) !== null;
}
