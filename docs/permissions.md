# Permission reference

<!-- Generated from packages/identity/src/domain/permissions.ts. Run `UPDATE_PERMISSION_REFERENCE=1 pnpm --filter @luma/identity test permission-reference` to refresh. -->

Each role grants a set of these permissions. Owner and Admin also hold every permission of installed apps. Sensitive permissions change provider data, money, access or policy, or read personal data. See [ADR-009](architecture/009-permissions-and-roles.md).

## Workspace

Workspace details and approval rules.

| Permission | Key | Description | Sensitive | Owner | Admin | Member |
| --- | --- | --- | --- | --- | --- | --- |
| Edit workspace settings | `workspace.settings.manage` | Change the workspace name and display time zone. |  | Yes | Yes |  |
| Manage approval rules | `workspace.approval_policy.manage` | Decide whether every allowed change needs approval from a second person. | Yes | Yes | Yes |  |

## Team and access

Who belongs to the workspace and what each role can do.

| Permission | Key | Description | Sensitive | Owner | Admin | Member |
| --- | --- | --- | --- | --- | --- | --- |
| Manage team members | `members.manage` | Invite people, change their role, and remove their access. People can only assign roles whose permissions they hold. | Yes | Yes | Yes |  |
| Manage roles | `roles.manage` | Create, edit, and archive custom roles, and see their change history. People can only grant permissions they hold. | Yes | Yes | Yes |  |

## Commerce records

Imported orders, stock, products, customers, and returns.

| Permission | Key | Description | Sensitive | Owner | Admin | Member |
| --- | --- | --- | --- | --- | --- | --- |
| View orders | `orders.read` | See orders, their lines, payments, and links to the source systems. |  | Yes | Yes | Yes |
| View fulfillment | `fulfillment.read` | See shipments, carriers, and fulfillment progress. |  | Yes | Yes | Yes |
| View inventory | `inventory.read` | See stock positions, locations, and stock history. |  | Yes | Yes | Yes |
| View products | `products.read` | See the product catalog and SKU comparisons. |  | Yes | Yes | Yes |
| View customers | `customers.read` | See customer profiles, including names, email addresses, and postal addresses. | Yes | Yes | Yes | Yes |
| View returns | `returns.read` | See returns, refunds, and money returned. |  | Yes | Yes | Yes |
| View insights | `insights.read` | See operational metrics, rule charts, and import coverage. |  | Yes | Yes | Yes |

## Issues and decisions

Operational issues, their evidence, and the decisions they need.

| Permission | Key | Description | Sensitive | Owner | Admin | Member |
| --- | --- | --- | --- | --- | --- | --- |
| View issues | `issues.read` | See issues, their evidence, diagnoses, and proposed changes. |  | Yes | Yes | Yes |
| Work on issues | `issues.manage` | Check, escalate, and resolve issues, refresh their evidence, and record what was learned. |  | Yes | Yes |  |
| Take decisions | `decisions.self_assign` | Take unassigned decisions in Needs you and release your own. |  | Yes | Yes | Yes |
| Assign decisions | `decisions.assign` | Assign or reassign any decision to a teammate. |  | Yes | Yes |  |
| Approve or reject changes | `decisions.respond` | Respond to approval requests. The approver must be someone other than the person who proposed the change. | Yes | Yes | Yes |  |

## Actions

Changes Luma makes in connected systems.

| Permission | Key | Description | Sensitive | Owner | Admin | Member |
| --- | --- | --- | --- | --- | --- | --- |
| Propose changes | `actions.propose` | Ask Luma to prepare changes in connected systems. Approval rules decide whether someone must approve them. | Yes | Yes | Yes |  |
| Apply changes | `actions.execute` | Apply allowed or approved changes in connected systems. Some changes need their own app permission instead. | Yes | Yes | Yes |  |

## Workflows

Workflows, their drafts, versions, and triggers.

| Permission | Key | Description | Sensitive | Owner | Admin | Member |
| --- | --- | --- | --- | --- | --- | --- |
| View workflows | `workflows.read` | See workflows, their versions, runs, and evidence. |  | Yes | Yes | Yes |
| Edit workflows | `workflows.author` | Create and edit drafts, generate drafts with Luma, and test drafts. |  | Yes | Yes |  |
| Publish and enable workflows | `workflows.publish` | Publish workflow versions and turn workflows on or off. | Yes | Yes | Yes |  |
| Manage workflow triggers | `workflows.triggers.manage` | Create, change, and pause schedules and event triggers. | Yes | Yes | Yes |  |
| Test and turn on issue workflows | `playbooks.activate` | Run Workflow tests on issues, review their results, and turn on issue workflows for selected records. | Yes | Yes | Yes |  |

## Procurement

Suppliers, purchase orders, and replenishment.

| Permission | Key | Description | Sensitive | Owner | Admin | Member |
| --- | --- | --- | --- | --- | --- | --- |
| View procurement | `procurement.read` | See suppliers, purchase orders, supplier commitments, and replenishment. |  | Yes | Yes | Yes |
| Manage procurement | `procurement.manage` | Edit suppliers and purchase orders, review supplier commitments, and set up replenishment. | Yes | Yes | Yes |  |

## Connections and apps

Connected systems, imports, and installed apps.

| Permission | Key | Description | Sensitive | Owner | Admin | Member |
| --- | --- | --- | --- | --- | --- | --- |
| Manage connections | `connections.manage` | Connect, reconnect, and disconnect systems. | Yes | Yes | Yes |  |
| Manage imports | `sync.manage` | Start, pause, and fix imports, and review links between imported records. |  | Yes | Yes |  |
| Manage apps | `apps.manage` | Install, update, and uninstall apps, and grant the access they request. | Yes | Yes | Yes |  |

## Ask Luma

Ask Luma questions about workspace data.

| Permission | Key | Description | Sensitive | Owner | Admin | Member |
| --- | --- | --- | --- | --- | --- | --- |
| Use Ask Luma | `assistant.use` | Ask questions about workspace data. Answers only include data this role can see. |  | Yes | Yes | Yes |

## Activity

The record of what people and Luma did.

| Permission | Key | Description | Sensitive | Owner | Admin | Member |
| --- | --- | --- | --- | --- | --- | --- |
| View activity | `activity.read` | See the workspace activity log. |  | Yes | Yes | Yes |
| View restricted activity | `activity.read_restricted` | See access changes, who made each change, and other restricted activity. | Yes | Yes | Yes |  |
