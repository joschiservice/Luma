import type {
  AuthoringVocabulary,
  DraftValidation,
  WorkflowDraft,
  WorkflowDraftContent,
  WorkflowTemplate,
} from '@luma/api-contract';

export const organizationId = '22222222-2222-4222-8222-222222222222';

const builtIn =
  'Purchase-order steps run only in the built-in Replenish low stock workflow. Use that template to create orders.';

/** A workspace vocabulary with computation steps and one built-in procurement adapter. */
export const vocabulary: AuthoringVocabulary = {
  triggers: [
    {
      kind: 'manual',
      label: 'Started by a person',
      description: 'Someone who can manage workflow triggers starts a run.',
      executable: true,
      reason: null,
    },
    {
      kind: 'event',
      label: 'When an event arrives',
      description: 'A system reports an event.',
      executable: true,
      reason: null,
    },
    {
      kind: 'schedule',
      label: 'At a scheduled time',
      description: 'The run starts once at a fixed time.',
      executable: false,
      reason:
        'Scheduled starts are recorded but do not run custom workflows yet.',
    },
    {
      kind: 'condition',
      label: 'When a condition is true',
      description: 'A monitored fact matches a value.',
      executable: true,
      reason: null,
    },
    {
      kind: 'exception',
      label: 'When an issue is detected',
      description: 'An operational issue is opened.',
      executable: true,
      reason: null,
    },
  ],
  stepKinds: [
    {
      kind: 'read',
      label: 'Read current data',
      description: 'Fetch fresh facts from a connected source.',
      executable: false,
      reason: builtIn,
    },
    {
      kind: 'condition',
      label: 'Check a condition',
      description: 'Continue only when a field has a specific value.',
      executable: true,
      reason: null,
    },
    {
      kind: 'capability',
      label: 'Take an action',
      description: 'Ask a connected system to make a change.',
      executable: false,
      reason: builtIn,
    },
    {
      kind: 'approval',
      label: 'Ask for approval',
      description:
        'Wait for someone who can approve changes to decide on the next action.',
      executable: false,
      reason:
        'No installed adapter runs this in custom workflows in this workspace.',
    },
    {
      kind: 'wait',
      label: 'Wait',
      description: 'Pause for a fixed time before continuing.',
      executable: true,
      reason: null,
    },
    {
      kind: 'verification',
      label: 'Check the result',
      description: 'Read the result independently.',
      executable: false,
      reason: builtIn,
    },
    {
      kind: 'escalation',
      label: 'Escalate',
      description: 'Stop and hand the run to a person.',
      executable: true,
      reason: null,
    },
    {
      kind: 'end',
      label: 'Finish',
      description: 'Finish the run with a named outcome.',
      executable: true,
      reason: null,
    },
    {
      kind: 'code',
      label: 'Run a Code Step',
      description: 'Compute values with sandboxed TypeScript.',
      executable: true,
      reason: null,
    },
  ],
  subjects: [
    {
      kind: 'inventory_position',
      label: 'Stock position',
      description: 'A mapped SKU at one location.',
      executable: false,
      reason: builtIn,
    },
    {
      kind: 'order',
      label: 'Order',
      description: 'A sales order.',
      executable: false,
      reason: builtIn,
    },
  ],
  reads: [
    {
      source: 'inventory',
      label: 'Current stock',
      description: 'Fresh available quantity, SKU and unit.',
      fields: {
        fresh: 'boolean',
        available: 'number',
        sku: 'string',
        unit: 'string',
      },
      executable: false,
      reason: builtIn,
    },
  ],
  capabilities: [
    {
      capability: 'procurement.purchase-order.create',
      version: '1',
      label: 'Create a purchase-order draft',
      description:
        'Records a draft purchase order for the supplier. It is not sent to the supplier.',
      targetKind: 'purchase_order',
      minimumRisk: 'medium',
      approval:
        'Workspace policy decides whether someone else who can approve changes must approve each order.',
      parameters: { quantity: 'number' },
      postcondition: { status: 'string' },
      evaluators: ['procurement/1'],
      executable: false,
      reason: builtIn,
    },
  ],
  evaluators: [
    {
      version: 'procurement/1',
      label: 'Check the purchase-order draft',
      description: 'Reads the order independently.',
      fields: {
        purchaseOrderId: 'string',
        quantity: 'number',
        status: 'string',
      },
      executable: false,
      reason: builtIn,
    },
  ],
  codeSteps: {
    executable: true,
    reason: null,
    evaluation: true,
    runtime: 'wasmtime-49.0.1/javy-9.1.0/typescript-5.9.3/1',
    limits: {
      fuel: 100_000_000,
      memoryBytes: 67_108_864,
      wallTimeMs: 5000,
      maxRequests: 0,
    },
  },
};

/** Two templates: one still needing setup, one ready and active. */
export const templates: WorkflowTemplate[] = [
  {
    id: 'inventory-replenishment',
    name: 'Replenish low stock',
    purpose:
      'Check low stock, review existing commitments, and create a verified purchase-order draft.',
    category: 'procurement',
    trigger: 'When available stock falls below the minimum you set',
    steps: [
      'Read current stock for the position you choose',
      'Stop when stock is stale or an order is already open',
      'Create a purchase-order draft for your supplier',
      'Check the draft independently',
    ],
    success:
      'A purchase-order draft exists for your supplier and is independently verified.',
    requirements: [
      {
        label: 'Workflow worker connected',
        met: true,
        detail: 'Replenishment runs on the workflow worker.',
        fix: null,
      },
      {
        label: 'A supplier',
        met: false,
        detail: 'Add the supplier you reorder from in Procurement.',
        fix: { label: 'Add a supplier', destination: 'procurement' },
      },
      {
        label: 'Mapped stock positions',
        met: true,
        detail: '3 stock position(s) with current stock.',
        fix: null,
      },
    ],
    readiness: 'blocked',
    status: 'inactive',
    configure: 'replenishment',
    installed: true,
    version: '1.0.0',
    digest: 'a'.repeat(64),
  },
  {
    id: 'shipping-method-correction',
    name: 'Correct an order shipping method',
    purpose:
      'Apply the mapped shipping method to an eligible order and verify the correction.',
    category: 'resolution',
    trigger: 'When Luma detects an order stuck on a wrong shipping method',
    steps: [
      'Check that the diagnosis is ready and the method is mapped',
      'Propose the mapped shipping method for the order',
      'Ask someone else who can approve changes to approve the change',
      'Read the order again to confirm the new method',
    ],
    success:
      'An independent read shows the mapped shipping method on the order.',
    requirements: [
      {
        label: 'A connection that can change shipping methods',
        met: true,
        detail:
          'A connection grants shipping-method changes and has mapped orders.',
        fix: null,
      },
    ],
    readiness: 'ready',
    status: 'active',
    configure: 'resolution',
    installed: true,
    version: '0.1.0',
    digest: 'b'.repeat(64),
  },
];

/** A three-step computation draft with one broken reference. */
export const content: WorkflowDraftContent = {
  schemaVersion: 2,
  definition: {
    id: 'restock-check',
    name: 'Check restock need',
    intent: 'Decide whether stock needs reordering.',
    category: 'custom',
  },
  version: '1.0.0',
  applicability: {
    trigger: { kind: 'manual' },
    subjectKind: 'inventory_position',
  },
  inputs: { target: 'number' },
  context: {
    kind: 'manual',
    fields: { available: 'number' },
    maxAgeSeconds: 300,
  },
  steps: [
    {
      id: 'compute',
      kind: 'code',
      source:
        'function main(input, luma) {\n  return { reorder: input.inputs.target > input.evidence.available };\n}',
      fields: { reorder: 'boolean' },
      grants: [],
      limits: {
        fuel: 100_000_000,
        memoryBytes: 67_108_864,
        wallTimeMs: 5000,
        maxRequests: 0,
      },
    },
    {
      id: 'needs-order',
      kind: 'condition',
      field: 'reorder',
      equals: true,
      onFalse: 'end',
    },
    { id: 'finish', kind: 'end', outcome: 'Reorder needed' },
  ],
};

/** Validation for `content`, with the scope each step can use. */
export const validation: DraftValidation = {
  revision: 3,
  content,
  publishable: false,
  diagnostics: [
    {
      severity: 'error',
      code: 'schema_too_small',
      stepIndex: null,
      stepId: null,
      field: 'definition.category',
      message: 'Choose a category people will recognise.',
      detail: 'definition.category: example',
    },
    {
      severity: 'warning',
      code: 'step_not_executable',
      stepIndex: 1,
      stepId: 'needs-order',
      field: null,
      message:
        'This step can’t run in this workspace yet. The workflow worker isn’t running on this Luma server.',
      detail: 'No executing adapter for condition step needs-order',
    },
  ],
  steps: [
    {
      index: 0,
      id: 'compute',
      kind: 'code',
      title: 'Run a Code Step',
      description: 'Compute reorder with sandboxed TypeScript.',
      scope: [
        { source: 'input', stepId: null, field: 'target', type: 'number' },
        {
          source: 'evidence',
          stepId: null,
          field: 'available',
          type: 'number',
        },
      ],
    },
    {
      index: 1,
      id: 'needs-order',
      kind: 'condition',
      title: 'Check a condition',
      description: 'Continue when reorder is yes. Otherwise finish.',
      scope: [
        { source: 'input', stepId: null, field: 'target', type: 'number' },
        {
          source: 'evidence',
          stepId: null,
          field: 'available',
          type: 'number',
        },
        {
          source: 'step',
          stepId: 'compute',
          field: 'reorder',
          type: 'boolean',
        },
      ],
    },
    {
      index: 2,
      id: 'finish',
      kind: 'end',
      title: 'Finish',
      description: 'Finish with “Reorder needed”.',
      scope: [],
    },
  ],
  summary:
    'When someone starts it, compute reorder with sandboxed TypeScript, then continue when reorder is yes.',
  printed: null,
  publishedVersions: [],
  suggestedVersion: '1.0.0',
};

/** A saved draft wrapping `content`. */
export const draft: WorkflowDraft = {
  id: '55555555-5555-4555-8555-555555555555',
  revision: 3,
  state: 'draft',
  mode: 'visual',
  content,
  codeView: null,
  basedOn: null,
  authorId: '66666666-6666-4666-8666-666666666666',
  updatedBy: '66666666-6666-4666-8666-666666666666',
  createdAt: '2026-09-28T08:00:00.000Z',
  updatedAt: '2026-09-28T08:10:00.000Z',
  published: null,
};
