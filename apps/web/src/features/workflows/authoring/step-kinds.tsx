import { m } from '@luma/i18n/messages';
import {
  BadgeCheck,
  Braces,
  Database,
  Flag,
  Hourglass,
  type LucideIcon,
  Siren,
  Split,
  UserCheck,
  Zap,
} from 'lucide-react';

import type { PaletteGroup, StepKind } from './draft-model';

/** Icon and short name for each step type. Colours come from `data-kind` in authoring.css. */
export const stepKinds: Record<
  StepKind,
  { icon: LucideIcon; name: () => string }
> = {
  human_task: { icon: UserCheck, name: m.authoring_coordination_human_label },
  event_wait: { icon: Hourglass, name: m.authoring_coordination_event_label },
  read: { icon: Database, name: m.authoring_step_kind_read },
  condition: { icon: Split, name: m.authoring_step_kind_condition },
  capability: { icon: Zap, name: m.authoring_step_kind_action },
  approval: { icon: UserCheck, name: m.authoring_step_kind_approval },
  wait: { icon: Hourglass, name: m.authoring_step_kind_wait },
  verification: { icon: BadgeCheck, name: m.authoring_step_kind_check },
  escalation: { icon: Siren, name: m.authoring_step_kind_escalation },
  end: { icon: Flag, name: m.authoring_step_kind_finish },
  code: { icon: Braces, name: m.authoring_step_kind_code },
};

/** Palette sections in the order a workflow usually reads. */
export const paletteGroups: { group: PaletteGroup; label: () => string }[] = [
  { group: 'data', label: m.authoring_palette_group_data },
  { group: 'decide', label: m.authoring_palette_group_decide },
  { group: 'act', label: m.authoring_palette_group_act },
  { group: 'compute', label: m.authoring_palette_group_compute },
  { group: 'finish', label: m.authoring_palette_group_finish },
];

/** The coloured icon badge for a step type. */
export function StepKindIcon({
  kind,
  size = 'md',
}: {
  kind: StepKind;
  size?: 'sm' | 'md';
}) {
  const Icon = stepKinds[kind].icon;

  return (
    <span className="authoring-kind-icon" data-kind={kind} data-size={size}>
      <Icon aria-hidden="true" size={size === 'sm' ? 14 : 16} />
    </span>
  );
}
