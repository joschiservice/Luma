import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { rich } from './rich';

const sentence = ({ count, link }: { count: number; link: unknown }) =>
  `${count === 1 ? 'One case' : `${count} cases`} need review. ${String(link)} to start.`;

describe('rich', () => {
  it('places elements where the message puts their placeholders', () => {
    const html = renderToStaticMarkup(
      <p>
        {rich(sentence, {
          count: 2,
          link: <a href="/needs-you">Open the queue</a>,
        })}
      </p>,
    );

    expect(html).toBe(
      '<p><span>2 cases need review. <a href="/needs-you">Open the queue</a> to start.</span></p>',
    );
  });
});
