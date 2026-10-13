import type { RolesSnapshot } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

type Text = () => string;

/*
 * Server permission text localized by stable key. Message keys follow the server catalog:
 * `permissions_<key>_label|description` with `.`, `:` and `-` replaced by `_`, groups as
 * `permissions_group_<id>_…` and built-in roles as `permissions_role_<key>_…`. Tests in
 * @luma/identity and each app package fail when the English messages and the server text
 * differ. Unknown keys, such as new server permissions or custom roles, keep the server text.
 */
const permissionText: Record<
  string,
  readonly [label: Text, description: Text]
> = {
  'workspace.settings.manage': [
    m.permissions_workspace_settings_manage_label,
    m.permissions_workspace_settings_manage_description,
  ],
  'workspace.approval_policy.manage': [
    m.permissions_workspace_approval_policy_manage_label,
    m.permissions_workspace_approval_policy_manage_description,
  ],
  'members.manage': [
    m.permissions_members_manage_label,
    m.permissions_members_manage_description,
  ],
  'roles.manage': [
    m.permissions_roles_manage_label,
    m.permissions_roles_manage_description,
  ],
  'sales.manage': [
    m.permissions_sales_manage_label,
    m.permissions_sales_manage_description,
  ],
  'orders.read': [
    m.permissions_orders_read_label,
    m.permissions_orders_read_description,
  ],
  'fulfillment.read': [
    m.permissions_fulfillment_read_label,
    m.permissions_fulfillment_read_description,
  ],
  'inventory.read': [
    m.permissions_inventory_read_label,
    m.permissions_inventory_read_description,
  ],
  'inventory.manage': [
    m.permissions_inventory_manage_label,
    m.permissions_inventory_manage_description,
  ],
  'inventory.approve': [
    m.permissions_inventory_approve_label,
    m.permissions_inventory_approve_description,
  ],
  'products.read': [
    m.permissions_products_read_label,
    m.permissions_products_read_description,
  ],
  'customers.read': [
    m.permissions_customers_read_label,
    m.permissions_customers_read_description,
  ],
  'returns.read': [
    m.permissions_returns_read_label,
    m.permissions_returns_read_description,
  ],
  'returns.manage': [
    m.permissions_returns_manage_label,
    m.permissions_returns_manage_description,
  ],
  'insights.read': [
    m.permissions_insights_read_label,
    m.permissions_insights_read_description,
  ],
  'issues.read': [
    m.permissions_issues_read_label,
    m.permissions_issues_read_description,
  ],
  'issues.manage': [
    m.permissions_issues_manage_label,
    m.permissions_issues_manage_description,
  ],
  'decisions.self_assign': [
    m.permissions_decisions_self_assign_label,
    m.permissions_decisions_self_assign_description,
  ],
  'decisions.assign': [
    m.permissions_decisions_assign_label,
    m.permissions_decisions_assign_description,
  ],
  'decisions.respond': [
    m.permissions_decisions_respond_label,
    m.permissions_decisions_respond_description,
  ],
  'actions.propose': [
    m.permissions_actions_propose_label,
    m.permissions_actions_propose_description,
  ],
  'actions.execute': [
    m.permissions_actions_execute_label,
    m.permissions_actions_execute_description,
  ],
  'workflows.read': [
    m.permissions_workflows_read_label,
    m.permissions_workflows_read_description,
  ],
  'workflows.author': [
    m.permissions_workflows_author_label,
    m.permissions_workflows_author_description,
  ],
  'workflows.publish': [
    m.permissions_workflows_publish_label,
    m.permissions_workflows_publish_description,
  ],
  'workflows.triggers.manage': [
    m.permissions_workflows_triggers_manage_label,
    m.permissions_workflows_triggers_manage_description,
  ],
  'playbooks.activate': [
    m.permissions_playbooks_activate_label,
    m.permissions_playbooks_activate_description,
  ],
  'procurement.read': [
    m.permissions_procurement_read_label,
    m.permissions_procurement_read_description,
  ],
  'procurement.manage': [
    m.permissions_procurement_manage_label,
    m.permissions_procurement_manage_description,
  ],
  'messages.read': [
    m.permissions_messages_read_label,
    m.permissions_messages_read_description,
  ],
  'messages.manage': [
    m.permissions_messages_manage_label,
    m.permissions_messages_manage_description,
  ],
  'messages.send': [
    m.permissions_messages_send_label,
    m.permissions_messages_send_description,
  ],
  'connections.manage': [
    m.permissions_connections_manage_label,
    m.permissions_connections_manage_description,
  ],
  'sync.manage': [
    m.permissions_sync_manage_label,
    m.permissions_sync_manage_description,
  ],
  'apps.manage': [
    m.permissions_apps_manage_label,
    m.permissions_apps_manage_description,
  ],
  'assistant.use': [
    m.permissions_assistant_use_label,
    m.permissions_assistant_use_description,
  ],
  'activity.read': [
    m.permissions_activity_read_label,
    m.permissions_activity_read_description,
  ],
  'activity.read_restricted': [
    m.permissions_activity_read_restricted_label,
    m.permissions_activity_read_restricted_description,
  ],
  'shopify:fulfillment_recovery.run': [
    m.permissions_shopify_fulfillment_recovery_run_label,
    m.permissions_shopify_fulfillment_recovery_run_description,
  ],
  'shopify:inventory_corrections.apply': [
    m.permissions_shopify_inventory_corrections_apply_label,
    m.permissions_shopify_inventory_corrections_apply_description,
  ],
  'shopify:order_edits.apply': [
    m.permissions_shopify_order_edits_apply_label,
    m.permissions_shopify_order_edits_apply_description,
  ],
  'shopify:shipment_publishing.run': [
    m.permissions_shopify_shipment_publishing_run_label,
    m.permissions_shopify_shipment_publishing_run_description,
  ],
  'starshipit:order_update.run': [
    m.permissions_starshipit_order_update_run_label,
    m.permissions_starshipit_order_update_run_description,
  ],
  'jtl:purchase_orders.submit': [
    m.permissions_jtl_purchase_orders_submit_label,
    m.permissions_jtl_purchase_orders_submit_description,
  ],
  'jtl:orders.shipping_method.write': [
    m.permissions_jtl_orders_shipping_method_write_label,
    m.permissions_jtl_orders_shipping_method_write_description,
  ],
  'gmail:messages.send': [
    m.permissions_gmail_messages_send_label,
    m.permissions_gmail_messages_send_description,
  ],
  'jtl:returns.create': [
    m.permissions_jtl_returns_create_label,
    m.permissions_jtl_returns_create_description,
  ],
};

const groupText: Record<string, readonly [label: Text, description: Text]> = {
  workspace: [
    m.permissions_group_workspace_label,
    m.permissions_group_workspace_description,
  ],
  access: [
    m.permissions_group_access_label,
    m.permissions_group_access_description,
  ],
  records: [
    m.permissions_group_records_label,
    m.permissions_group_records_description,
  ],
  issues: [
    m.permissions_group_issues_label,
    m.permissions_group_issues_description,
  ],
  actions: [
    m.permissions_group_actions_label,
    m.permissions_group_actions_description,
  ],
  workflows: [
    m.permissions_group_workflows_label,
    m.permissions_group_workflows_description,
  ],
  procurement: [
    m.permissions_group_procurement_label,
    m.permissions_group_procurement_description,
  ],
  messaging: [
    m.permissions_group_messaging_label,
    m.permissions_group_messaging_description,
  ],
  connections: [
    m.permissions_group_connections_label,
    m.permissions_group_connections_description,
  ],
  assistant: [
    m.permissions_group_assistant_label,
    m.permissions_group_assistant_description,
  ],
  activity: [
    m.permissions_group_activity_label,
    m.permissions_group_activity_description,
  ],
};

const roleText: Record<string, readonly [name: Text, description: Text]> = {
  owner: [m.permissions_role_owner_name, m.permissions_role_owner_description],
  admin: [m.permissions_role_admin_name, m.permissions_role_admin_description],
  member: [
    m.permissions_role_member_name,
    m.permissions_role_member_description,
  ],
};

const lookup = <T>(map: Record<string, T>, key: string) =>
  Object.hasOwn(map, key) ? map[key] : undefined;

/** Returns a core or app permission's label in the interface language, or `fallback`. */
export function permissionLabel(key: string, fallback: string) {
  return lookup(permissionText, key)?.[0]() ?? fallback;
}

/** Returns a core or app permission's description in the interface language, or `fallback`. */
export function permissionDescription(key: string, fallback: string) {
  return lookup(permissionText, key)?.[1]() ?? fallback;
}

/**
 * Returns a built-in role's name in the interface language. Built-in role IDs equal their key;
 * custom roles keep the name their author typed.
 */
export function roleName(role: { id: string; name: string }) {
  return lookup(roleText, role.id)?.[0]() ?? role.name;
}

/** Returns a built-in role's description in the interface language; custom roles keep theirs. */
function roleDescription(role: { id: string; description: string }) {
  return lookup(roleText, role.id)?.[1]() ?? role.description;
}

/**
 * Localizes a roles snapshot: permission groups, permissions and built-in roles. App groups are
 * named after their app; their description depends on whether the app is available.
 */
export function localizeRoles(snapshot: RolesSnapshot): RolesSnapshot {
  return {
    roles: snapshot.roles.map((role) =>
      role.builtIn
        ? { ...role, name: roleName(role), description: roleDescription(role) }
        : role,
    ),
    groups: snapshot.groups.map((group) => {
      const text = lookup(groupText, group.id);
      if (group.app)
        return {
          ...group,
          description: group.app.available
            ? m.permissions_app_group_description({ app: group.app.name })
            : m.permissions_app_group_unavailable({ app: group.app.name }),
        };

      return text
        ? { ...group, label: text[0](), description: text[1]() }
        : group;
    }),
    permissions: snapshot.permissions.map((permission) => ({
      ...permission,
      label: permissionLabel(permission.key, permission.label),
      description: permissionDescription(
        permission.key,
        permission.description,
      ),
    })),
  };
}
