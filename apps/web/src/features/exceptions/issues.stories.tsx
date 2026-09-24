import { caseFixture, inventoryCase } from '@luma/ui/components/case-fixtures';
import {
  CaseInvestigation,
  CaseRow,
} from '@luma/ui/components/case-investigation';
import { IssueDetailViews } from '@luma/ui/components/issue-collection';
import { IssueInspectorHeader } from '@luma/ui/components/issue-inspector-header';
import { IssueSummary } from '@luma/ui/components/issue-summary';
import { Pagination } from '@luma/ui/components/pagination';
import { WorkspaceAccountMenu } from '@luma/ui/components/workspace-account-menu';
import { figmaScreen } from '@luma/ui/lib/figma';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inbox, LayoutDashboard, Unplug } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MINIMAL_VIEWPORTS } from 'storybook/viewport';

import appStyles from '../../styles.css?inline';
import { Brand } from '../identity/common';
import { WorkspaceLayout } from '../identity/workspace-layout';

const issues = [
  inventoryCase,
  caseFixture('sync_failure'),
  caseFixture('stuck_fulfillment'),
  caseFixture('workflow_failure'),
  caseFixture('pending'),
];

function IssuesExample({
  selectedInitially = true,
  longEvidence = false,
}: {
  selectedInitially?: boolean;
  longEvidence?: boolean;
}) {
  const [selected, setSelected] = useState<number | undefined>(
    selectedInitially ? 0 : undefined,
  );
  const [page, setPage] = useState(1);
  const selectedItem = selected === undefined ? undefined : issues[selected];
  const item =
    selectedItem && longEvidence && selectedItem.diagnosis
      ? {
          ...selectedItem,
          diagnosis: {
            ...selectedItem.diagnosis,
            provenance: {
              ...selectedItem.diagnosis.provenance,
              evidence: Array.from({ length: 48 }, (_, index) => ({
                ...selectedItem.diagnosis!.provenance.evidence[0]!,
                id: `evidence-${index}`,
              })),
            },
          },
        }
      : selectedItem;

  return (
    <>
      <style>{appStyles}</style>
      <WorkspaceLayout
        brand={<Brand />}
        context={
          <>
            <span>Operations</span>
            <span>/</span>
            <span>Issues</span>
          </>
        }
        navigation={() => (
          <nav aria-label="Workspace navigation">
            {[
              { name: 'Overview', Icon: LayoutDashboard },
              { name: 'Issues', Icon: Inbox },
              { name: 'Connections', Icon: Unplug },
            ].map(({ name, Icon }) => (
              <a
                key={name}
                href={`#${name}`}
                className={name === 'Issues' ? 'active' : undefined}
                aria-current={name === 'Issues' ? 'page' : undefined}
              >
                <Icon size={18} />
                {name}
              </a>
            ))}
          </nav>
        )}
        accountMenu={
          <WorkspaceAccountMenu
            name="Alex Morgan"
            workspace="Northstar Commerce"
            workspaceId="northstar"
            workspaces={[
              {
                id: 'northstar',
                name: 'Northstar Commerce',
                link: <a href="#workspace" />,
              },
            ]}
            createLink={<a href="#new" />}
            switchLink={<a href="#switch" />}
          />
        }
      >
        <div
          className={`inbox ${selected !== undefined ? 'inbox-selected' : ''}`}
        >
          <h1 className="sr-only">Issues</h1>
          <IssueSummary review={3} open={5} verified={12} />
          <div className="inbox-workspace">
            <div className="inbox-list">
              <nav className="inbox-views" aria-label="Issue views">
                <a href="#review" aria-current="page">
                  Needs review
                </a>
                <a href="#open">All open</a>
                <a href="#history">History</a>
              </nav>
              <ul className="inbox-rows">
                {issues.map((item, index) => (
                  <li key={index}>
                    <a
                      href={`#issue-${index}`}
                      aria-current={selected === index ? 'page' : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        setSelected(index);
                      }}
                    >
                      <CaseRow item={item} />
                    </a>
                  </li>
                ))}
              </ul>
              <Pagination
                count={page === 1 ? 25 : 21}
                totalCount={46}
                page={page}
                hasNext={page === 1}
                onPrevious={page > 1 ? () => setPage(page - 1) : undefined}
                onNext={() => setPage(page + 1)}
              />
            </div>
            {selected !== undefined && (
              <section className="inbox-detail" aria-label="Selected issue">
                <IssueDetailViews
                  key={selected}
                  issueTitle={item?.summary}
                  headerClassName="inbox-case-nav"
                  header={
                    <IssueInspectorHeader
                      className="inbox-case-nav"
                      item={issues[selected]!}
                      onClose={() => setSelected(undefined)}
                    />
                  }
                >
                  <CaseInvestigation item={item!} embedded />
                </IssueDetailViews>
              </section>
            )}
          </div>
        </div>
      </WorkspaceLayout>
    </>
  );
}

const meta = {
  title: 'App/Issues workspace',
  component: IssuesExample,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: MINIMAL_VIEWPORTS },
    design: figmaScreen('issuesLight'),
  },
} satisfies Meta<typeof IssuesExample>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  globals: { theme: 'dark' },
  parameters: { design: figmaScreen('issuesDark') },
};

export const InboxOnly: Story = {
  args: { selectedInitially: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('button', { name: 'Previous' }),
    ).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(canvas.getByText('26–46 of 46 issues')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Previous' }));
    await expect(canvas.getByText('1–25 of 46 issues')).toBeVisible();
    await userEvent.click(
      canvas.getByText('Shopify shows 8 more available than JTL'),
    );
    await expect(
      canvas.getByRole('region', { name: 'Selected issue' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Close panel' }));
    await expect(
      canvas.queryByRole('region', { name: 'Selected issue' }),
    ).not.toBeInTheDocument();
  },
};

export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const LongEvidence: Story = {
  args: { longEvidence: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByText('Findings & evidence', { exact: true }),
    );
    await userEvent.click(
      canvas.getByRole('button', {
        name: 'View all 48 supporting evidence records',
      }),
    );
    await expect(
      canvas.getByRole('heading', { name: 'Supporting evidence' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Close panel' }),
    ).not.toBeInTheDocument();
    const header = canvas
      .getByRole('heading', { name: 'Supporting evidence' })
      .closest('header')!;
    await expect(within(header).getByText('48 records')).toBeVisible();
    await expect(
      within(header).getByText('Shopify shows 8 more available than JTL.'),
    ).toBeVisible();
    await userEvent.click(
      within(header).getByRole('button', { name: 'Back to issue' }),
    );
    await expect(
      canvas.getByRole('button', { name: 'Close panel' }),
    ).toBeVisible();
  },
};
