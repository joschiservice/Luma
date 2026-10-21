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
    description: 'Workspace details and approval rules.',
  },
  {
    id: 'access',
    label: 'Team and access',
    description: 'Who belongs to the workspace and what each role can do.',
  },
  {
    id: 'records',
    label: 'Commerce records',
    description: 'Imported orders, stock, products, customers, and returns.',
  },
  {
    id: 'issues',
    label: 'Issues and decisions',
    description:
      'Operational issues, their evidence, and the decisions they need.',
  },
  {
    id: 'actions',
    label: 'Actions',
    description: 'Changes Luma makes in connected systems.',
  },
  {
    id: 'workflows',
    label: 'Workflows',
    description: 'Workflows, their drafts, versions, and triggers.',
  },
  {
    id: 'procurement',
    label: 'Procurement',
    description: 'Suppliers, purchase orders, and replenishment.',
  },
  {
    id: 'messaging',
    label: 'Operations inbox',
    description:
      'Message threads from connected mailboxes, their documents, and replies.',
  },
  {
    id: 'connections',
    label: 'Connections and apps',
    description: 'Connected systems, imports, and installed apps.',
  },
  {
    id: 'assistant',
    label: 'Ask Luma',
    description: 'Ask Luma questions about workspace data.',
  },
  {
    id: 'activity',
    label: 'Activity',
    description: 'The record of what people and Luma did.',
  },
] as const satisfies readonly PermissionGroup[];

/**
 * Describes the permission group of an installed app. Apps whose package is missing from the
 * deployment keep their group, but its permissions have no effect.
 */
export function appPermissionGroupDescription(app: string, available: boolean) {
  return available
    ? `Permissions for ${app}’s own features.`
    : `${app} isn’t available on this Luma server, so its permissions have no effect.`;
}

const introduced = '2026-10-06';

/**
 * Every core permission. Add new capabilities here: built-in Owner and Admin receive them
 * through code, custom roles only when someone grants them.
 */
export const permissionCatalog = [
  {
    key: 'adaptive.fields.read',
    group: 'records',
    label: 'View custom fields',
    description: 'See custom fields on records you can access.',
    consequential: false,
    introduced: '2026-10-13',
  },
  {
    key: 'adaptive.fields.write',
    group: 'records',
    label: 'Edit custom field values',
    description: 'Change Luma-owned custom fields on records you can access.',
    consequential: true,
    introduced: '2026-10-13',
  },
  {
    key: 'adaptive.fields.manage',
    group: 'workspace',
    label: 'Manage custom fields',
    description:
      'Define and archive typed custom fields and their access rules.',
    consequential: true,
    introduced: '2026-10-13',
  },
  {
    key: 'adaptive.views.manage',
    group: 'workspace',
    label: 'Manage shared views',
    description:
      'Share views with the workspace or roles, and edit and archive views other members own.',
    consequential: false,
    introduced: '2026-10-13',
  },
  {
    key: 'lists.export',
    group: 'workspace',
    label: 'Export lists',
    description:
      'Download lists as CSV files with the columns you can see. Every export is recorded in the audit log.',
    consequential: true,
    introduced: '2026-10-13',
  },
  {
    key: 'adaptive.packages.manage',
    group: 'workspace',
    label: 'Manage operational packages',
    description: 'Review, install and remove operational package definitions.',
    consequential: true,
    introduced: '2026-10-13',
  },

  {
    key: 'sales.manage',
    group: 'records',
    label: 'Manage Luma orders',
    description:
      'Accept storefront orders and read and edit Luma order records, including addresses.',
    consequential: true,
    introduced: '2026-10-11',
  },
  {
    key: 'workspace.settings.manage',
    group: 'workspace',
    label: 'Edit workspace settings',
    description:
      'Change the workspace name, display time zone and authoritative sources.',
    consequential: false,
    introduced,
  },
  {
    key: 'workspace.approval_policy.manage',
    group: 'workspace',
    label: 'Manage approval rules',
    description:
      'Choose when changes need approval and whether another person must approve.',
    consequential: true,
    introduced,
  },
  {
    key: 'members.manage',
    group: 'access',
    label: 'Manage team members',
    description:
      'Invite people, change their role, and remove their access. People can only assign roles whose permissions they hold.',
    consequential: true,
    introduced,
  },
  {
    key: 'roles.manage',
    group: 'access',
    label: 'Manage roles',
    description:
      'Create, edit, and archive custom roles, and see their change history. People can only grant permissions they hold.',
    consequential: true,
    introduced,
  },
  {
    key: 'support_access.manage',
    group: 'access',
    label: 'Manage Luma support access',
    description:
      'Allow or revoke read-only access for Luma support, approve or decline their access and inspection requests, and end inspections early.',
    consequential: true,
    introduced: '2026-10-10',
  },
  {
    key: 'orders.read',
    group: 'records',
    label: 'View orders',
    description:
      'See orders, their lines, payments, and links to the source systems.',
    consequential: false,
    introduced,
  },
  {
    key: 'fulfillment.read',
    group: 'records',
    label: 'View fulfillment',
    description: 'See shipments, carriers, and fulfillment progress.',
    consequential: false,
    introduced,
  },
  {
    key: 'inventory.read',
    group: 'records',
    label: 'View inventory',
    description: 'See stock positions, locations, and stock history.',
    consequential: false,
    introduced,
  },
  {
    key: 'inventory.manage',
    group: 'records',
    label: 'Manage native stock',
    description:
      'Prepare reviewed stock openings and corrections, manage native stock movements and reconcile the shadow ledger.',
    consequential: true,
    introduced: '2026-10-12',
  },
  {
    key: 'inventory.approve',
    group: 'records',
    label: 'Review native stock changes',
    description:
      'Approve or reject another member’s exact stock opening or correction.',
    consequential: true,
    introduced: '2026-10-12',
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
      'See customer profiles, including names, email addresses, and postal addresses.',
    consequential: true,
    introduced,
  },
  {
    key: 'customers.erase',
    group: 'records',
    label: 'Erase customers',
    description:
      'Erase a customer’s profile, order addresses and inbox messages for a data-subject request.',
    consequential: true,
    introduced: '2026-10-18',
  },
  {
    key: 'returns.read',
    group: 'records',
    label: 'View returns',
    description: 'See returns, refunds, and money returned.',
    consequential: false,
    introduced,
  },
  {
    key: 'returns.manage',
    group: 'records',
    label: 'Manage returns',
    description:
      'Open return cases, record receipt and inspection, propose resolutions, and request returns in connected systems.',
    consequential: true,
    introduced: '2026-10-11',
  },
  {
    key: 'insights.read',
    group: 'records',
    label: 'View insights',
    description: 'See operational metrics, rule charts, and import coverage.',
    consequential: false,
    introduced,
  },
  {
    key: 'issues.read',
    group: 'issues',
    label: 'View issues',
    description: 'See issues, their evidence, diagnoses, and proposed changes.',
    consequential: false,
    introduced,
  },
  {
    key: 'issues.manage',
    group: 'issues',
    label: 'Work on issues',
    description:
      'Check and escalate issues, close them with a reason, verify resolutions, refresh evidence, and record what was learned.',
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
      'Respond to approval requests. When the workspace requires approval from another person, the approver can’t be the person who proposed the change.',
    consequential: true,
    introduced,
  },
  {
    key: 'actions.propose',
    group: 'actions',
    label: 'Propose changes',
    description:
      'Ask Luma to prepare changes in connected systems. Approval rules decide whether someone must approve them.',
    consequential: true,
    introduced,
  },
  {
    key: 'actions.execute',
    group: 'actions',
    label: 'Apply changes',
    description:
      'Apply allowed or approved changes in connected systems. Some changes need their own app permission instead.',
    consequential: true,
    introduced,
  },
  {
    key: 'workflows.read',
    group: 'workflows',
    label: 'View workflows',
    description: 'See workflows, their versions, runs, and evidence.',
    consequential: false,
    introduced,
  },
  {
    key: 'workflows.author',
    group: 'workflows',
    label: 'Edit workflows',
    description:
      'Create and edit drafts, generate drafts with Luma, and test drafts.',
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
    description: 'Create, change, and pause schedules and event triggers.',
    consequential: true,
    introduced,
  },
  {
    key: 'playbooks.activate',
    group: 'workflows',
    label: 'Test and turn on issue workflows',
    description:
      'Run Workflow tests on issues, review their results, and turn on issue workflows for selected records.',
    consequential: true,
    introduced,
  },
  {
    key: 'procurement.read',
    group: 'procurement',
    label: 'View procurement',
    description:
      'See suppliers, purchase orders, supplier commitments, and replenishment.',
    consequential: false,
    introduced,
  },
  {
    key: 'procurement.manage',
    group: 'procurement',
    label: 'Manage procurement',
    description:
      'Edit suppliers and purchase orders, review supplier commitments, and set up replenishment.',
    consequential: true,
    introduced,
  },
  {
    key: 'messages.read',
    group: 'messaging',
    label: 'View message threads',
    description:
      'Read message threads from connected mailboxes, their attachments, and the records they are linked to.',
    consequential: true,
    introduced: '2026-10-11',
  },
  {
    key: 'messages.manage',
    group: 'messaging',
    label: 'Work on message threads',
    description:
      'Assign threads, write internal notes, set reply deadlines, link records, review document facts, and choose which messages Luma reads.',
    consequential: true,
    introduced: '2026-10-11',
  },
  {
    key: 'messages.send',
    group: 'messaging',
    label: 'Send replies',
    description:
      'Draft replies and send them, or request approval when they make commitments.',
    consequential: true,
    introduced: '2026-10-11',
  },
  {
    key: 'connections.manage',
    group: 'connections',
    label: 'Manage connections',
    description: 'Connect, reconnect, and disconnect systems.',
    consequential: true,
    introduced,
  },
  {
    key: 'sync.manage',
    group: 'connections',
    label: 'Manage imports',
    description:
      'Start, pause, and fix imports, and review links between imported records.',
    consequential: false,
    introduced,
  },
  {
    key: 'apps.manage',
    group: 'connections',
    label: 'Manage apps',
    description:
      'Install, update, and uninstall apps, and grant the access they request.',
    consequential: true,
    introduced,
  },
  {
    key: 'api_apps.create',
    group: 'connections',
    label: 'Create personal API apps',
    description:
      'Create API apps that read workspace data for you with a token, limited to permissions you hold. People who manage apps can see and revoke them.',
    consequential: true,
    introduced: '2026-10-20',
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
      'See access changes, who made each change, and other restricted activity.',
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
