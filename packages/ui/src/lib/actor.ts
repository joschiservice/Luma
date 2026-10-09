import type { ActivityActor } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

/**
 * Names who recorded an event: a person's name, a former member, Luma or a service. A workflow
 * run is named together with the person it acted for. Email is added only with `email`, and
 * only current members have one.
 */
export function actorLabel(
  actor: ActivityActor,
  { email = false }: { email?: boolean } = {},
) {
  let label: string;
  switch (actor.kind) {
    case 'member':
    case 'former_member':
      label = !actor.name
        ? m.common_actor_former_member()
        : actor.kind === 'member'
          ? actor.name
          : m.common_actor_former_member_named({ name: actor.name });
      break;
    case 'luma':
      label = m.common_actor_luma();
      break;
    case 'service':
      label = m.common_actor_service({ name: actor.name ?? actor.id ?? '' });
      break;
    default:
      return m.common_actor_not_recorded();
  }
  if (email && actor.email)
    label = m.common_actor_with_email({ actor: label, email: actor.email });

  return actor.workflow
    ? m.common_actor_via_workflow({
        actor: label,
        workflow: actor.workflow.name ?? m.common_actor_workflow_unnamed(),
      })
    : label;
}

/**
 * Names the person behind a recorded user ID from the people a response lists. An ID that is not
 * listed is shown as a former member, because responses list every person they reference.
 */
export function personLabel(people: readonly ActivityActor[], id: string) {
  return actorLabel(
    people.find((person) => person.id === id) ?? {
      kind: 'former_member',
      id,
      name: null,
      email: null,
      workflow: null,
    },
  );
}

/**
 * Names a recorded author: the listed person for a user ID, or the value itself when it is a
 * name already, such as "Luma". Responses list every user ID they reference.
 */
export function authorLabel(people: readonly ActivityActor[], author: string) {
  const person = people.find((item) => item.id === author);

  return person ? actorLabel(person) : author;
}
