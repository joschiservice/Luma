# ADR-006: First-party workspace apps

Status: accepted

## Decision

Integrations and optional UI features are app packages. Core depends on normalized capabilities and host contracts. A deployment catalog registers available apps; a separate tenant-owned installation record enables each app for a workspace.

Connectors are optional app contributions. Provider-specific configuration, validation, transports, normalization, OAuth, and UI remain app-owned. Core owns authorization, credential encryption, evidence storage, and controlled execution. Detection consumes explicit normalized provenance; eligibility consumes capabilities.

App UI has separate build entry points and loads only after workspace installation is confirmed. Catalog metadata is available without loading app implementations. The host offers settings, connection setup, and page slots. First-party modules share the existing React runtime and design system.

Uninstall atomically revokes credentials and grants while retaining historical evidence. Installation versions reject stale authorization and credential persistence. Missing app implementations produce an unavailable contribution rather than a core startup dependency.

## App permissions, scopes and consent

Added by [ADR-009](009-permissions-and-roles.md). Manifests declare the app's own permissions (`<app-id>:<name>`), the core scopes it needs, and a permission for each UI slot and decision kind; registration validates them. Installing grants exactly the requested scopes, which the installer must hold; scopes added by an upgrade wait for approval. When an app acts for a person it is limited to what the person's permissions, the app's granted scopes and the app's own permission all allow. The host checks installation and declared permissions before app routes run, mounts slots only for people who hold their permission, and filters app decisions; apps hold no role logic. Uninstalling removes scope grants and the app's permissions from every role in the same transaction; reinstalling restores neither.

## Consequences

The deployment catalog is generated from app directories. App removal requires catalog regeneration and dependency installation, followed by a rebuild. Core code is unchanged. App migrations are namespaced and immutable; removing code does not drop data.

First-party apps are trusted code, so they share process resources and must follow host contracts. Process sandboxing, third-party distribution, independent frontend deployments, and marketplace billing are outside this architecture.

See [Workspace apps](../apps.md) for lifecycle, authoring, and validation details.
