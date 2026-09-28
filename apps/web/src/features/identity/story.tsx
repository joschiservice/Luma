import { StatePill } from '@luma/ui/components/primitives/state';
import { ArrowRight } from 'lucide-react';

const steps = [
  {
    state: 'error',
    label: 'Problem',
    title: 'Order stuck',
    detail: 'The shop shows an order that fulfillment hasn’t picked up.',
  },
  {
    state: 'running',
    label: 'Action',
    title: 'Retry approved',
    detail: 'The agreed fix is sent to the fulfillment system.',
  },
  {
    state: 'verified',
    label: 'Check',
    title: 'Order moving',
    detail: 'The system confirms that fulfillment has resumed.',
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
          <li key={step.title} style={{ animationDelay: `${index * 140}ms` }}>
            <StatePill state={step.state}>{step.label}</StatePill>
            <strong>{step.title}</strong>
            <span>{step.detail}</span>
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
      <figcaption>
        Example: how Luma handles an order stuck between systems.
      </figcaption>
    </figure>
  );
}
