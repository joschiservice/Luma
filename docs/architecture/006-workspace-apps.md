# ADR-006: First-party workspace apps

Status: accepted

## Decision

Integrations and optional UI features are app packages. Core depends on normalized capabilities and host contracts. A deployment catalog registers available apps; a separate tenant-owned installation record enables each app for a workspace.

Connectors are optional app contributions. Provider-specific configuration, validation, transports, normalization, OAuth, and UI remain app-owned. Core owns authorization, credential encryption, evidence storage, and controlled execution. Detection consumes explicit normalized provenance; eligibility consumes capabilities.

App UI has separate build entry points and loads only after workspace installation is confirmed. Catalog metadata is available without loading app implementations. The host offers settings, connection setup, and page slots. First-party modules share the existing React runtime and design system.

Uninstall atomically revokes credentials and grants while retaining historical evidence. Installation versions reject stale authorization and credential persistence. Missing app implementations produce an unavailable contribution rather than a core startup dependency.

## Consequences

The deployment catalog is generated from app directories. App removal requires catalog regeneration and dependency installation, followed by a rebuild. Core code is unchanged. App migrations are namespaced and immutable; removing code does not drop data.

First-party apps are trusted code, so they share process resources and must follow host contracts. Process sandboxing, third-party distribution, independent frontend deployments, and marketplace billing are outside this architecture.

See [Workspace apps](../apps.md) for lifecycle, authoring, and validation details.
