import type { Permission, TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import { forbidden, notFound } from '@luma/platform';

import type { WorkflowDraftContent } from '../domain/draft.js';
import type { WorkflowTemplate } from '../domain/template.js';

/** A domain adapter's published definition, offered as a template. */
export interface TemplateSource {
  id: string;
  /** Describes the template and what it still needs in this workspace. */
  template(context: TenantContext): Promise<WorkflowTemplate>;
  /** Returns the template as draft content for customizing a copy. */
  content(): WorkflowDraftContent;
  /** Publishes the template's immutable version here if it is missing. Grants nothing. */
  install(context: TenantContext): Promise<void>;
}

/** Lists templates from installed adapters and prepares them for configuration or customizing. */
export function createWorkflowTemplates(deps: {
  sources: TemplateSource[];
  refreshContext(context: TenantContext): Promise<TenantContext>;
}) {
  async function authorize(context: TenantContext, permission: Permission) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, permission);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');

    return fresh;
  }

  function source(id: string) {
    const found = deps.sources.find((item) => item.id === id);
    if (!found) throw notFound('Template not found.');

    return found;
  }

  return {
    /** Lists every template with its requirements, readiness and activation status. */
    async list(context: TenantContext) {
      context = await authorize(context, 'workflows.read');

      return Promise.all(deps.sources.map((item) => item.template(context)));
    },
    /**
     * Publishes the template's version in this workspace so it can be configured. Repeating it is
     * safe. Installing never activates the workflow.
     */
    async install(context: TenantContext, id: string) {
      context = await authorize(context, 'workflows.publish');
      const found = source(id);
      await found.install(context);

      return found.template(context);
    },
    /** Returns template content for a customized copy. Callers authorize the draft creation. */
    content(id: string) {
      return source(id).content();
    },
  };
}

export type WorkflowTemplates = ReturnType<typeof createWorkflowTemplates>;
