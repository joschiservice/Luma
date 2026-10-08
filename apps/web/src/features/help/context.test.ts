import { describe, expect, it } from 'vitest';

import { contextualTopic, docLocation } from './context';

describe('contextual help', () => {
  it('uses the most specific topic and inherits a parent topic when needed', () => {
    const inbox = { staticData: { help: 'issues' as const } };
    const issue = { staticData: { help: 'issues/investigate' as const } };
    expect(contextualTopic([inbox, issue])).toBe('issues/investigate');
    expect(contextualTopic([inbox, { staticData: {} }])).toBe('issues');
    expect(contextualTopic([{ staticData: {} }])).toBeUndefined();
    expect(
      contextualTopic([
        { staticData: {} },
        { staticData: { help: 'workflows/create' as const } },
      ]),
    ).toBe('workflows/create');
  });

  it('chooses a topic from the route parameters when a route serves several pages', () => {
    const settings = {
      staticData: {
        help: ({ section }: Record<string, string | undefined>) =>
          section === 'roles' ? 'roles-and-permissions' : 'workspace-settings',
      },
    } as const;
    expect(
      contextualTopic([{ ...settings, params: { section: 'roles' } }]),
    ).toBe('roles-and-permissions');
    expect(
      contextualTopic([{ ...settings, params: { section: 'team' } }]),
    ).toBe('workspace-settings');
  });

  it('preserves article anchors without treating external or app links as documentation', () => {
    expect(docLocation('/docs/issues/resolve#confirm-the-outcome')).toEqual({
      slug: 'issues/resolve',
      hash: 'confirm-the-outcome',
    });
    expect(docLocation('/docs/issues')).toEqual({ slug: 'issues', hash: '' });
    for (const href of [
      'https://example.com/docs/issues',
      '//example.com/docs/issues',
      '/app/workspaces',
      '/docs-search',
      '/docs/',
    ])
      expect(docLocation(href)).toBeUndefined();
  });
});
