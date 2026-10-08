import { m } from '@luma/i18n/messages';
import { StatePill } from '@luma/ui/components/primitives/state';
import { ArrowRight } from 'lucide-react';

const steps = [
  {
    state: 'error',
    label: m.identity_story_problem_label,
    title: m.identity_story_problem_title,
    detail: m.identity_story_problem_detail,
  },
  {
    state: 'running',
    label: m.identity_story_action_label,
    title: m.identity_story_action_title,
    detail: m.identity_story_action_detail,
  },
  {
    state: 'verified',
    label: m.identity_story_check_label,
    title: m.identity_story_check_title,
    detail: m.identity_story_check_detail,
  },
] as const;

/**
 * Illustrates how Luma handles a stuck order: a problem, the agreed action and the
 * verified result. It is an explanatory example, not live workspace data.
 */
export function ResolutionStory() {
  return (
    <figure className="resolution-story">
      <ol>
        {steps.map((step, index) => (
          <li key={step.state} style={{ animationDelay: `${index * 140}ms` }}>
            <StatePill state={step.state}>{step.label()}</StatePill>
            <strong>{step.title()}</strong>
            <span>{step.detail()}</span>
            {index < steps.length - 1 ? (
              <ArrowRight
                className="resolution-story-arrow"
                size={14}
                aria-hidden="true"
              />
            ) : null}
          </li>
        ))}
      </ol>
      <figcaption>{m.identity_story_caption()}</figcaption>
    </figure>
  );
}
