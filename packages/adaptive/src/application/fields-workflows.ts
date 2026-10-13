import type { EffectRegistry } from '@luma/connections';
import type {
  ActionAdmission,
  ActivatedArtifact,
  BoundActionStep,
} from '@luma/execution';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  isPermission,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { canonicalJson } from '@luma/platform';
import type { PolicyService } from '@luma/policies';
import type {
  CodeProcessBusinessAdapter,
  ProcessRun,
  ProcessStepOutput,
  ProcessWorkflowVersion,
  VocabularyContribution,
  WorkflowTriggerRun,
} from '@luma/workflows';

import type {
  AdaptiveRecordType,
  CustomField,
  CustomFieldValue,
} from '../domain/fields.js';
import type { FieldWorkflowReview } from '../domain/fields-workflows.js';
import type { AdaptiveFields } from './fields.js';
import {
  fieldVerificationVersion,
  fieldWriteCapability,
  isFieldWriteCapability,
} from './fields-effects.js';

type ProcessStep = ProcessWorkflowVersion['steps'][number];

export interface FieldWorkflowAdapter extends CodeProcessBusinessAdapter {
  eligible(context: TenantContext, binding: BoundActionStep): Promise<boolean>;
  pending(context: TenantContext): Promise<FieldWorkflowReview[]>;
  review(
    context: TenantContext,
    runId: string,
    stepId: string,
  ): Promise<FieldWorkflowReview>;
  respond(
    context: TenantContext,
    runId: string,
    stepId: string,
    input: {
      decisionId: string;
      reviewedActionHash: string;
      outcome: 'approved' | 'rejected';
    },
  ): Promise<FieldWorkflowReview>;
}

interface Provisioning {
  activate(
    context: TenantContext,
    input: {
      id: string;
      version: string;
      generation: { kind: 'manual'; reference: string };
      steps: Record<
        string,
        {
          capability: string;
          capabilityVersion: string;
          targetKind: string;
          minimumRisk: 'medium';
        }
      >;
    },
  ): Promise<ActivatedArtifact>;
  step(
    context: TenantContext,
    runId: string,
    stepId: string,
  ): Promise<BoundActionStep | null>;
  bind(
    context: TenantContext,
    input: Omit<BoundActionStep, 'actionHash'>,
  ): Promise<void>;
}

const recordTypes: AdaptiveRecordType[] = [
  'order',
  'product',
  'supplier',
  'purchase_order',
];

function recordType(value: string): AdaptiveRecordType {
  if (
    value === 'order' ||
    value === 'product' ||
    value === 'supplier' ||
    value === 'purchase_order'
  )
    return value;
  throw new IdentityError(
    422,
    'VALIDATION_ERROR',
    'Custom field workflows require a supported record subject.',
  );
}

function valueOf(
  value: Extract<ProcessStep, { kind: 'capability' }>['parameters'][string],
  run: ProcessRun,
  outputs: ProcessStepOutput[],
) {
  if (value.source === 'literal') return value.value;
  if (value.source === 'input') return run.context.inputs[value.field];
  if (value.source === 'evidence')
    return run.context.evidence.facts[value.field];

  if (value.source === 'step')
    return outputs.find((o) => o.stepId === value.stepId)?.values[value.field];
  throw new IdentityError(
    422,
    'VALIDATION_ERROR',
    'Unsupported workflow value reference.',
  );
}

/** Supplies permission-visible field reads and admission-bound writes to custom workflow processes. */
export function createFieldsWorkflowAdapter(deps: {
  fields: AdaptiveFields;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  policies: Pick<PolicyService, 'decision' | 'respond' | 'evaluate'>;
  version(
    context: TenantContext,
    id: string,
    version: string,
  ): Promise<ProcessWorkflowVersion | null>;
  outputs(context: TenantContext, runId: string): Promise<ProcessStepOutput[]>;
  pendingReferences(
    context: TenantContext,
  ): Promise<{ runId: string; stepId: string }[]>;
  latestDecisionId(
    context: TenantContext,
    proposalId: string,
  ): Promise<string | null>;
  effects: EffectRegistry;
  admission: ActionAdmission;
  provisioning: Provisioning;
  resolveContext(run: ProcessRun): Promise<TenantContext>;
  run(context: TenantContext, id: string): Promise<WorkflowTriggerRun | null>;
  enabled: boolean;
  id(value: string): string;
  parseStoredValue(value: unknown): CustomFieldValue;
  parseValue(field: CustomField, value: unknown): CustomFieldValue;
  now(): Date;
}): FieldWorkflowAdapter {
  async function authorize(run: ProcessRun) {
    const context = await deps.resolveContext(run);
    requireTenant(context, run.tenantId);
    if (context.actor.id !== run.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Workflow principal changed.');

    return context;
  }

  function readSelection(source: string) {
    const match =
      /^adaptive\.field\.([0-9a-f-]{36})(?:\.choice\.([a-z][a-z0-9_]{0,63}))?$/.exec(
        source,
      );

    return match?.[1]
      ? { fieldId: match[1], ...(match[2] ? { choiceKey: match[2] } : {}) }
      : null;
  }

  const supports = (step: ProcessStep) =>
    step.kind === 'read'
      ? readSelection(step.source) !== null
      : step.kind === 'capability'
        ? isFieldWriteCapability(step.capability) &&
          step.capabilityVersion === '1'
        : step.kind === 'approval'
          ? true
          : step.kind === 'verification'
            ? step.evaluatorVersion === fieldVerificationVersion
            : false;

  async function eligible(context: TenantContext, binding: BoundActionStep) {
    if (!isFieldWriteCapability(binding.action.capability)) return false;
    const run = await deps.run(context, binding.runId);
    if (
      !run ||
      run.state !== 'awaiting_admission' ||
      run.actor.id !== context.actor.id ||
      run.subject.id !== binding.action.target.id ||
      run.subject.kind !== binding.action.target.kind
    )
      return false;
    const effect = await deps.effects.resolve(context, binding.action);

    return !!effect && effect.checkPreconditions(binding.action);
  }

  async function freshContext(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');
    requirePermission(fresh, 'adaptive.fields.read');

    return fresh;
  }

  async function review(
    context: TenantContext,
    runId: string,
    stepId: string,
  ): Promise<FieldWorkflowReview> {
    context = await freshContext(context);
    const binding = await deps.provisioning.step(context, runId, stepId);
    if (
      !binding ||
      !isFieldWriteCapability(binding.action.capability) ||
      binding.subject?.kind !== 'adaptive_field_change'
    )
      throw new IdentityError(
        404,
        'NOT_FOUND',
        'Field workflow proposal not found.',
      );
    const run = await deps.run(context, runId);
    if (!run)
      throw new IdentityError(404, 'NOT_FOUND', 'Workflow run not found.');
    const type = recordType(binding.action.target.kind);
    const record = await deps.fields.readValues(
      context,
      type,
      binding.action.target.id,
    );
    const field = record.fields.find(
      (f) => f.id === binding.action.parameters.fieldId,
    );
    if (!field) throw new IdentityError(404, 'NOT_FOUND', 'Field not found.');
    const current = record.values.find((v) => v.fieldId === field.id);
    const decisionId = await deps.latestDecisionId(context, binding.action.id);
    const decision = decisionId
      ? await deps.policies.decision(context, decisionId)
      : null;
    const receipt = await deps.admission.get(context, binding.action.id);
    const status =
      receipt?.state === 'succeeded'
        ? 'succeeded'
        : decision?.approval?.outcome === 'approved'
          ? 'approved'
          : decision?.approval?.outcome === 'rejected'
            ? 'rejected'
            : decision?.outcome === 'approval_required'
              ? 'approval_required'
              : 'unavailable';
    const stale =
      run.state !== 'awaiting_admission' ||
      field.revision !== binding.action.parameters.fieldRevision ||
      (current?.revision ?? 0) !== binding.action.parameters.revision ||
      Date.parse(binding.action.expiresAt) <= deps.now().getTime();

    return {
      runId,
      stepId,
      definitionId: run.definitionId,
      field,
      recordType: type,
      recordId: binding.action.target.id,
      beforeValue: deps.parseStoredValue(
        JSON.parse(String(binding.action.parameters.beforeValueJson ?? 'null')),
      ),
      proposedValue: deps.parseStoredValue(
        JSON.parse(String(binding.action.parameters.valueJson)),
      ),
      revision: Number(binding.action.parameters.revision),
      currentRevision: current?.revision ?? 0,
      fieldRevision: Number(binding.action.parameters.fieldRevision),
      currentFieldRevision: field.revision,
      decisionId,
      actionHash: binding.actionHash,
      requesterId: binding.principalId,
      requestedAt: run.createdAt,
      expiresAt: binding.action.expiresAt,
      canRespond:
        status === 'approval_required' &&
        !stale &&
        !context.supportView &&
        hasPermission(context, 'decisions.respond') &&
        hasPermission(context, 'adaptive.fields.write') &&
        isPermission(field.writePermission) &&
        hasPermission(context, field.writePermission) &&
        (!(decision?.requireIndependentApproval ?? true) ||
          binding.principalId !== context.actor.id),
      requireIndependentApproval: decision?.requireIndependentApproval ?? true,
      stale,
      status,
      risk: 'medium',
    };
  }

  const adapter: FieldWorkflowAdapter = {
    supports,
    review,
    async pending(context: TenantContext) {
      context = await freshContext(context);
      const result: FieldWorkflowReview[] = [];
      for (const reference of await deps.pendingReferences(context)) {
        try {
          const item = await review(context, reference.runId, reference.stepId);
          if (item.status === 'approval_required') result.push(item);
        } catch (error) {
          if (
            error instanceof IdentityError &&
            (error.statusCode === 403 || error.statusCode === 404)
          )
            continue;
          throw error;
        }
      }

      return result;
    },
    async respond(
      context: TenantContext,
      runId: string,
      stepId: string,
      input: {
        decisionId: string;
        reviewedActionHash: string;
        outcome: 'approved' | 'rejected';
      },
    ) {
      context = await freshContext(context);
      requireChangesAllowed(context);
      requirePermission(context, 'decisions.respond');
      const item = await review(context, runId, stepId);
      if (
        item.stale ||
        item.decisionId !== input.decisionId ||
        item.actionHash !== input.reviewedActionHash
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'The field proposal changed. Review it again.',
        );
      if (!item.canRespond)
        throw new IdentityError(
          403,
          'FORBIDDEN',
          'You cannot respond to this field proposal.',
        );
      await deps.policies.respond(
        context,
        input.decisionId,
        input.outcome,
        item.expiresAt,
      );

      return review(context, runId, stepId);
    },
    admission: deps.admission,
    eligible,
    async vocabulary(context: TenantContext): Promise<VocabularyContribution> {
      const reads: NonNullable<VocabularyContribution['reads']> = [];
      const capabilities: NonNullable<VocabularyContribution['capabilities']> =
        [];
      const subjects: NonNullable<VocabularyContribution['subjects']> = [];
      for (const type of recordTypes) {
        let fields;
        try {
          fields = await deps.fields.list(context, type);
        } catch (error) {
          if (
            error instanceof IdentityError &&
            (error.statusCode === 403 || error.statusCode === 404)
          )
            continue;
          throw error;
        }
        if (!fields.length) continue;
        subjects.push({
          kind: type,
          label: type.replaceAll('_', ' '),
          description: 'A Luma commerce record with typed workspace fields.',
          executable: deps.enabled,
          reason: deps.enabled ? null : 'The workflow worker is unavailable.',
        });
        for (const field of fields) {
          const selections =
            field.type === 'multi_choice'
              ? field.choices.map((choice) => ({
                  source: `adaptive.field.${field.id}.choice.${choice.key}`,
                  label: `${field.label.en}: ${choice.label.en}`,
                  type: 'boolean' as const,
                }))
              : [
                  {
                    source: `adaptive.field.${field.id}`,
                    label: field.label.en,
                    type:
                      field.type === 'number'
                        ? ('number' as const)
                        : field.type === 'boolean'
                          ? ('boolean' as const)
                          : ('string' as const),
                  },
                ];
          for (const selection of selections)
            reads.push({
              source: selection.source,
              label: selection.label,
              description:
                'Read the current custom field. Check present before using value: an unset field returns present false and a type default, not a known value.',
              fields: {
                value: selection.type,
                present: 'boolean',
                revision: 'number',
              },
              executable: deps.enabled,
              reason: deps.enabled
                ? null
                : 'The workflow worker is unavailable.',
            });
        }
        if (fields.some((field) => field.source === 'luma'))
          capabilities.push({
            capability: fieldWriteCapability(type),
            version: '1',
            label: 'Change a custom field',
            description:
              'Write a reviewed typed field value with fresh permissions, approval policy and independent verification.',
            targetKind: type,
            minimumRisk: 'medium',
            approval:
              'Workspace approval rules apply; permission and both revisions are checked again before writing.',
            parameters: { fieldId: 'string', valueJson: 'string' },
            postcondition: { valueJson: 'string' },
            evaluators: [fieldVerificationVersion],
            executable: deps.enabled,
            reason: deps.enabled ? null : 'The workflow worker is unavailable.',
          });
      }

      return {
        reads,
        capabilities,
        subjects,
        stepKinds: (
          ['read', 'capability', 'approval', 'verification'] as const
        ).map((kind) => ({
          kind,
          executable: deps.enabled,
          ...(!deps.enabled
            ? { reason: 'The workflow worker is unavailable.' }
            : {}),
        })),
        evaluators: [
          {
            version: fieldVerificationVersion,
            label: 'Verify custom field value',
            description:
              'Read the field independently and compare the admitted value and revision.',
            fields: { matches: 'boolean' },
            executable: deps.enabled,
            reason: deps.enabled ? null : 'The workflow worker is unavailable.',
          },
        ],
      };
    },
    async read(run: ProcessRun, step: Extract<ProcessStep, { kind: 'read' }>) {
      const context = await authorize(run);
      const selection = readSelection(step.source);
      if (!selection)
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'Unsupported field read.',
        );
      const type = recordType(run.subject.kind);
      const record = await deps.fields.readValues(
        context,
        type,
        run.subject.id,
      );
      const field = record.fields.find((f) => f.id === selection.fieldId);
      if (!field) throw new IdentityError(404, 'NOT_FOUND', 'Field not found.');
      const current = record.values.find((v) => v.fieldId === field.id);
      const raw = current?.value ?? null;
      let value: string | number | boolean | null;
      if (field.type === 'multi_choice') {
        if (
          !selection.choiceKey ||
          !field.choices.some((c) => c.key === selection.choiceKey)
        )
          throw new IdentityError(
            422,
            'VALIDATION_ERROR',
            'Choose a multiple-choice option for this field read.',
          );
        value =
          raw === null
            ? null
            : Array.isArray(raw) && raw.includes(selection.choiceKey);
      } else {
        if (selection.choiceKey || Array.isArray(raw))
          throw new IdentityError(
            422,
            'VALIDATION_ERROR',
            'This field read is invalid.',
          );
        value = raw;
      }

      return {
        values: {
          value:
            value ??
            (field.type === 'number'
              ? 0
              : field.type === 'boolean' || selection.choiceKey
                ? false
                : ''),
          present: value !== null,
          revision: current?.revision ?? 0,
        },
        evidenceRefs: [field.id],
        observedAt: deps.now().toISOString(),
      };
    },
    async bindAction(
      context: TenantContext,
      run: ProcessRun,
      version: ProcessWorkflowVersion,
      step: Extract<ProcessStep, { kind: 'capability' }>,
      outputs: ProcessStepOutput[],
    ) {
      requirePermission(context, 'workflows.triggers.manage');
      requirePermission(context, 'adaptive.fields.write');
      const type = recordType(run.subject.kind);
      if (
        step.capability !== fieldWriteCapability(type) ||
        step.targetKind !== type ||
        step.capabilityVersion !== '1'
      )
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'Unsupported field write.',
        );
      const prior = await deps.provisioning.step(context, run.id, step.id);
      if (prior) return { proposalId: prior.action.id };
      const fieldId = step.parameters.fieldId
        ? valueOf(step.parameters.fieldId, run, outputs)
        : null;
      const valueJson = step.parameters.valueJson
        ? valueOf(step.parameters.valueJson, run, outputs)
        : null;
      if (typeof fieldId !== 'string' || typeof valueJson !== 'string')
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'Map a field identity and JSON typed value.',
        );
      const parsedValue = JSON.parse(valueJson);
      const record = await deps.fields.readValues(
        context,
        type,
        run.subject.id,
      );
      const field = record.fields.find((f) => f.id === fieldId);
      if (!field || field.source !== 'luma')
        throw new IdentityError(
          409,
          'CONFLICT',
          'This field cannot be written.',
        );
      const value = deps.parseValue(field, parsedValue);
      if (
        canonicalJson(value).length > 1000 ||
        canonicalJson(
          record.values.find((item) => item.fieldId === field.id)?.value ??
            null,
        ).length > 1000
      )
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'Workflow field changes support JSON values up to 1,000 characters.',
        );
      // A single activated artifact is bound to this persisted run, reviewed version and principal.
      const artifact = await deps.provisioning.activate(context, {
        id: `adaptive-fields:${run.id}`,
        version: version.version,
        generation: { kind: 'manual', reference: version.digest },
        steps: Object.fromEntries(
          version.steps
            .filter(
              (item): item is Extract<ProcessStep, { kind: 'capability' }> =>
                item.kind === 'capability',
            )
            .map((item) => [
              item.id,
              {
                capability: item.capability,
                capabilityVersion: item.capabilityVersion,
                targetKind: item.targetKind,
                minimumRisk: 'medium' as const,
              },
            ]),
        ),
      });
      const validUntil = new Date(
        deps.now().getTime() + 4 * 60 * 60 * 1000,
      ).toISOString();
      const current = record.values.find((v) => v.fieldId === field.id);
      const proposalId = deps.id(`${run.id}:${step.id}:field-change`);
      const action = {
        schemaVersion: 1 as const,
        id: proposalId,
        tenantId: context.tenantId,
        connectionId: context.tenantId,
        capability: step.capability,
        capabilityVersion: '1',
        target: { kind: type, id: run.subject.id },
        parameters: {
          fieldId,
          beforeValueJson: canonicalJson(current?.value ?? null),
          valueJson: canonicalJson(value),
          revision: current?.revision ?? 0,
          fieldRevision: field.revision,
        },
        expectedPostcondition: { valueJson: canonicalJson(value) },
        preconditions: {
          evidenceRefs: [field.id],
          validUntil,
        },
        risk: 'medium' as const,
        proposedBy: { kind: 'user' as const, id: context.actor.id },
        expiresAt: validUntil,
      };
      const effect = await deps.effects.resolve(context, action);
      if (!effect || !(await effect.checkPreconditions(action)))
        throw new IdentityError(
          409,
          'CONFLICT',
          'The field change is unavailable.',
        );
      await deps.provisioning.bind(context, {
        runId: run.id,
        stepId: step.id,
        tenantId: context.tenantId,
        principalId: context.actor.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'adaptive_field_change', id: run.subject.id },
        eligibilityValidUntil: validUntil,
        action,
      });

      return { proposalId };
    },
    async decision(
      run: ProcessRun,
      step: Extract<ProcessStep, { kind: 'approval' }>,
    ) {
      const context = await authorize(run);
      let binding = await deps.provisioning.step(context, run.id, step.forStep);
      if (!binding) {
        const version = await deps.version(
          context,
          run.definitionId,
          run.version,
        );
        if (!version || version.digest !== run.versionDigest)
          throw new IdentityError(
            409,
            'CONFLICT',
            'The workflow version is unavailable.',
          );
        const action = version.steps.find(
          (item): item is Extract<ProcessStep, { kind: 'capability' }> =>
            item.kind === 'capability' && item.id === step.forStep,
        );
        if (!action)
          throw new IdentityError(
            422,
            'VALIDATION_ERROR',
            'The approval has no supported action.',
          );
        await adapter.bindAction(
          context,
          run,
          version,
          action,
          await deps.outputs(context, run.id),
        );
        binding = await deps.provisioning.step(context, run.id, step.forStep);
      }
      if (!binding) return { state: 'pending' as const };
      const effect = await deps.effects.resolve(context, binding.action);
      if (!effect)
        throw new IdentityError(
          409,
          'CONFLICT',
          'The field change is unavailable.',
        );
      const decision = await deps.policies.evaluate(
        context,
        binding.action,
        binding.actionHash,
        {
          available: true,
          minimumRisk: 'medium',
          permission: effect.permission ?? 'adaptive.fields.write',
        },
      );
      if (decision.outcome === 'allowed')
        return { state: 'approved' as const, decisionId: decision.id };
      if (decision.outcome === 'denied')
        return { state: 'denied' as const, decisionId: decision.id };

      return { state: 'pending' as const };
    },
    async verify(
      run: ProcessRun,
      step: Extract<ProcessStep, { kind: 'verification' }>,
    ) {
      const context = await authorize(run);
      const binding = await deps.provisioning.step(
        context,
        run.id,
        step.forStep,
      );
      if (!binding)
        throw new IdentityError(404, 'NOT_FOUND', 'Field action not found.');
      const effect = await deps.effects.resolve(context, binding.action);
      const result = await effect?.verify(binding.action);

      return {
        state:
          result?.outcome === 'passed'
            ? ('verified' as const)
            : result?.outcome === 'failed'
              ? ('failed' as const)
              : ('inconclusive' as const),
        values: { matches: result?.outcome === 'passed' },
        evidenceRefs: result?.observationRefs ?? [],
      };
    },
  };

  return adapter;
}
