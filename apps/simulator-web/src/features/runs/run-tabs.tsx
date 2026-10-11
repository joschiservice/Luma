import type { RunDetail } from '@luma/simulator-contract';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';

import { useSearchParam } from '../../lib/location';
import { ChaosView } from '../chaos/chaos-view';
import { IncidentsView } from '../incidents/incidents-view';
import { JournalView } from '../journal/journal-view';
import { MailboxView } from '../mailbox/mailbox-view';
import { OverviewView } from '../overview/overview-view';
import { ProvidersView } from '../providers/providers-view';
import { ScorecardView } from '../scorecard/scorecard-view';

const tabs = [
  { value: 'overview', label: 'Overview' },
  { value: 'chaos', label: 'Chaos' },
  { value: 'incidents', label: 'Incidents' },
  { value: 'scorecard', label: 'Scorecard' },
  { value: 'providers', label: 'Providers' },
  { value: 'mailbox', label: 'Mailbox' },
  { value: 'journal', label: 'Journal' },
] as const;

type Tab = (typeof tabs)[number]['value'];

const isTab = (value: string): value is Tab =>
  tabs.some((tab) => tab.value === value);

/**
 * The ready run's views. Only the open tab is mounted, so hidden views neither render nor poll.
 * The open tab is kept in the address.
 */
export function RunTabs({ run }: { run: RunDetail }) {
  const [tab, setTab] = useSearchParam<Tab>('tab', 'overview', isTab);

  return (
    <Tabs
      value={tab}
      onValueChange={(value: Tab) => setTab(value)}
      className="sim-tabs"
    >
      <TabsList aria-label="Run views" className="sim-tabs-list">
        {tabs.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
            {item.value === 'incidents' && run.counts.activeIncidents > 0 ? (
              <span className="sim-count lu-numeric">
                {run.counts.activeIncidents}
                <span className="sr-only"> active</span>
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="overview">
        <OverviewView run={run} />
      </TabsContent>
      <TabsContent value="chaos">
        <ChaosView run={run} />
      </TabsContent>
      <TabsContent value="incidents">
        <IncidentsView run={run} />
      </TabsContent>
      <TabsContent value="scorecard">
        <ScorecardView run={run} />
      </TabsContent>
      <TabsContent value="providers">
        <ProvidersView run={run} />
      </TabsContent>
      <TabsContent value="mailbox">
        <MailboxView run={run} />
      </TabsContent>
      <TabsContent value="journal">
        <JournalView run={run} />
      </TabsContent>
    </Tabs>
  );
}
