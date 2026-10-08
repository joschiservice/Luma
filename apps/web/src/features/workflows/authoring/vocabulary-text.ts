import type { AuthoringVocabulary } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

type Text = readonly [label: () => string, description: () => string];

/*
 * Workflow vocabulary localized by kind: `vocabulary_trigger_<kind>_…`, `vocabulary_step_<kind>_…`
 * and `vocabulary_subject_<kind>_…`, each with `_label` and `_description`. Tests in the server
 * packages that define these entries fail when the English messages and the server text differ.
 * Entries the client doesn't know keep the server text, as do reads, actions and checks that
 * installed apps describe.
 */
const triggers: Record<string, Text> = {
  manual: [
    m.vocabulary_trigger_manual_label,
    m.vocabulary_trigger_manual_description,
  ],
  event: [
    m.vocabulary_trigger_event_label,
    m.vocabulary_trigger_event_description,
  ],
  schedule: [
    m.vocabulary_trigger_schedule_label,
    m.vocabulary_trigger_schedule_description,
  ],
  condition: [
    m.vocabulary_trigger_condition_label,
    m.vocabulary_trigger_condition_description,
  ],
  exception: [
    m.vocabulary_trigger_exception_label,
    m.vocabulary_trigger_exception_description,
  ],
};

const steps: Record<string, Text> = {
  read: [m.vocabulary_step_read_label, m.vocabulary_step_read_description],
  condition: [
    m.vocabulary_step_condition_label,
    m.vocabulary_step_condition_description,
  ],
  capability: [
    m.vocabulary_step_capability_label,
    m.vocabulary_step_capability_description,
  ],
  approval: [
    m.vocabulary_step_approval_label,
    m.vocabulary_step_approval_description,
  ],
  wait: [m.vocabulary_step_wait_label, m.vocabulary_step_wait_description],
  verification: [
    m.vocabulary_step_verification_label,
    m.vocabulary_step_verification_description,
  ],
  escalation: [
    m.vocabulary_step_escalation_label,
    m.vocabulary_step_escalation_description,
  ],
  end: [m.vocabulary_step_end_label, m.vocabulary_step_end_description],
  code: [m.vocabulary_step_code_label, m.vocabulary_step_code_description],
};

const subjects: Record<string, Text> = {
  order: [
    m.vocabulary_subject_order_label,
    m.vocabulary_subject_order_description,
  ],
  inventory_position: [
    m.vocabulary_subject_inventory_position_label,
    m.vocabulary_subject_inventory_position_description,
  ],
  purchase_order: [
    m.vocabulary_subject_purchase_order_label,
    m.vocabulary_subject_purchase_order_description,
  ],
};

function localize<
  T extends { kind: string; label: string; description: string },
>(map: Record<string, Text>, entry: T): T {
  if (!Object.hasOwn(map, entry.kind)) return entry;
  const [label, description] = map[entry.kind]!;

  return { ...entry, label: label(), description: description() };
}

/** Returns the vocabulary with known triggers, step types and subjects in the interface language. */
export function localizeVocabulary(
  vocabulary: AuthoringVocabulary,
): AuthoringVocabulary {
  return {
    ...vocabulary,
    triggers: vocabulary.triggers.map((entry) => localize(triggers, entry)),
    stepKinds: vocabulary.stepKinds.map((entry) => localize(steps, entry)),
    subjects: vocabulary.subjects.map((entry) => localize(subjects, entry)),
  };
}
