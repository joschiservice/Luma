# ADR-009: Permission catalog and workspace roles

Status: accepted · 2026-10-07 · [LUMA-135](https://linear.app/auren-labs/issue/LUMA-135)

## Context

Authorization used three hardcoded membership roles. Services compared role names in about 100 places, and checks such as `role !== 'member'` would have granted management access to any new role. Policy, apps and the web each repeated the role list.

## Decision

Features ask one question: does this person hold permission X?

- **Catalog.** `packages/identity/src/domain/permissions.ts` defines every core permission with a stable dotted key, group, label, description and a `consequential` flag. `Permission` is a union derived from it. The [permission reference](../permissions.md) is generated from the catalog and checked by a test.
- **Roles.** Owner, Admin and Member are defined in code and can't be edited. Owner and Admin hold every core permission and every installed app's permissions; Member holds the read and self-service set. Ownership is a role, not a permission: only owners grant or remove it. Workspaces add custom roles (`workspace_roles`, `workspace_role_permissions`). A membership or invitation points at one role: a built-in key, or `custom` with `custom_role_id` and a same-tenant foreign key. Custom roles never gain catalog additions automatically.
- **Context.** The membership lookup resolves the role and its grants in one statement. `TenantContext` carries `actor.role` and an immutable `PermissionSet`. `requirePermission` and `hasPermission` replace role checks; ESLint rejects role comparisons and `requireRole` outside identity.
- **Routes.** Every tenant contract route declares `metadata` (`requires(...)` or `anyMember`); routes registered directly declare `config.access`. The request guard denies undeclared routes. Services check again on a refreshed context, so workers and continuations see role changes at the next step.
- **Policy.** Callers pass the permission a step needs: a capability's own permission when it declares one, otherwise `actions.propose` or `actions.execute`. Approvers need `decisions.respond`, and the capability's app permission when it has one. The approver still differs from the requester.
- **Guardrails.** `roles.manage` edits roles and `members.manage` assigns them. Non-owners can't grant, assign or change anything beyond their own permissions. Role edits use revisions and `x-command-id` receipts and serialize on the workspace row with membership changes. Roles in use can't be archived; archiving revokes their pending invitations.
- **Apps.** Manifests declare namespaced permissions (`<appId>:<name>`), the core scopes they need, and a permission for each UI slot and decision kind; registration validates them. Installing grants exactly the requested scopes, which the installer must hold. Upgrades' new scopes stay pending until approved. When an app acts for a person, it may only do what the person's permissions, the app's granted scopes and the app's own permission all allow. Uninstall removes scope grants and the app's role permissions in the same transaction through `revoke_app_role_permissions`, recording the cause in each role's history; reinstalling restores nothing.

## Options considered

- **More fixed roles.** Cheap, but every feature still encodes role names and workspaces can't express needs such as "approve purchase orders only".
- **Per-resource permissions or attribute rules.** More expressive, but harder to read and audit. Deferred.
- **Role-aware RLS.** RLS stays tenant-scoped ([ADR-003](003-tenant-isolation-and-data-residency.md)); permissions are checked in services.

## Consequences

- Adding a capability means adding a catalog entry and requiring it. Built-in roles follow automatically; custom roles need an explicit grant.
- One role per membership keeps effective access readable.
- The legacy Better Auth `invitations` table stays because the organization plugin checks for it at startup; Luma never exposes it.
- Background work that runs as a stored person stops with an explicit unavailable state when that person loses a permission. Workspace-owned service principals are [LUMA-56](https://linear.app/auren-labs/issue/LUMA-56).
- Apps outside this repository would need authentication and an out-of-process host; the manifest contract is plain data so that follow-up need not change it.

Reversal cost: high. Role data migrates easily back to keys, but every service and route now declares permissions.
