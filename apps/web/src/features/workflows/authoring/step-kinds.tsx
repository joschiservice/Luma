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
export const stepKinds: Record<StepKind, { icon: LucideIcon; name: string }> = {
  read: { icon: Database, name: 'Read data' },
  condition: { icon: Split, name: 'Condition' },
  capability: { icon: Zap, name: 'Action' },
  approval: { icon: UserCheck, name: 'Approval' },
  wait: { icon: Hourglass, name: 'Wait' },
  verification: { icon: BadgeCheck, name: 'Result check' },
  escalation: { icon: Siren, name: 'Escalate' },
  end: { icon: Flag, name: 'Finish' },
  code: { icon: Braces, name: 'Code Step' },
};

/** Palette sections in the order a workflow usually reads. */
export const paletteGroups: { group: PaletteGroup; label: string }[] = [
  { group: 'data', label: 'Get data' },
  { group: 'decide', label: 'Decide and wait' },
  { group: 'act', label: 'Take action' },
  { group: 'compute', label: 'Compute' },
  { group: 'finish', label: 'Finish' },
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
