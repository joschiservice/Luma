import type {
  AdaptiveRecordType,
  CustomField,
  CustomFieldValue,
} from './fields.js';

/** A policy-bound field change shown consistently in Needs you and the affected record. */
export interface FieldWorkflowReview {
  runId: string;
  stepId: string;
  definitionId: string;
  field: CustomField;
  recordType: AdaptiveRecordType;
  recordId: string;
  beforeValue: CustomFieldValue;
  proposedValue: CustomFieldValue;
  revision: number;
  currentRevision: number;
  fieldRevision: number;
  currentFieldRevision: number;
  decisionId: string | null;
  actionHash: string;
  requesterId: string;
  requestedAt: string;
  expiresAt: string;
  canRespond: boolean;
  requireIndependentApproval: boolean;
  stale: boolean;
  status:
    'approval_required' | 'approved' | 'rejected' | 'succeeded' | 'unavailable';
  risk: 'medium';
}
