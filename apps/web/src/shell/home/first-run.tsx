import type { OperationsOverview } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { buttonVariants } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  type OperationalState,
  StateDot,
} from '@luma/ui/components/primitives/state';
import { Link } from '@tanstack/react-router';
import { Plug } from 'lucide-react';

import { usePermissions } from '../../kit/identity/permissions';

type Step = 'done' | 'yours' | 'luma' | 'later';

const stepStates: Record<Step, OperationalState> = {
  done: 'verified',
  yours: 'attention',
  luma: 'running',
  later: 'idle',
};

const stepLabels: Record<Step, () => string> = {
  done: m.home_first_run_step_done,
  yours: m.home_first_run_step_yours,
  luma: m.home_first_run_step_luma,
  later: m.home_first_run_step_later,
};

/**
 * Leads a new workspace from connecting a system, through the first import, to the first
 * outcome Luma verified with a fresh read. People who manage apps get the Shopify setup;
 * everyone else learns who can do it.
 */
export function FirstRun({
  organizationId,
  data,
}: {
  organizationId: string;
  data: OperationsOverview;
}) {
  const { can, ready } = usePermissions(organizationId);
  const connected = data.connections.length > 0;
  const imported = data.connections.some(
    (connection) => connection.lastObservedAt,
  );
  const verified = data.verifiedResolutions > 0;
  const steps = [
    {
      id: 'connect',
      title: m.home_first_run_connect_title(),
      description: m.home_first_run_connect_description(),
      step: connected ? 'done' : 'yours',
    },
    {
      id: 'import',
      title: m.home_first_run_import_title(),
      description: m.home_first_run_import_description(),
      step: imported ? 'done' : connected ? 'luma' : 'later',
    },
    {
      id: 'verify',
      title: m.home_first_run_verify_title(),
      description: m.home_first_run_verify_description(),
      step: verified ? 'done' : imported ? 'luma' : 'later',
    },
  ] satisfies { id: string; title: string; description: string; step: Step }[];

  return (
    <Card as="section" className="home-first-run" aria-labelledby="first-run">
      <div className="home-first-run-intro">
        <h2 id="first-run">
          {connected
            ? m.home_notice_waiting_title()
            : m.home_notice_first_title()}
        </h2>
        <p>
          {connected
            ? m.home_notice_waiting_description()
            : m.home_notice_first_description()}
        </p>
        {!ready ? null : can('apps.manage') ? (
          <div className="home-first-run-actions">
            {connected ? (
              <Link
                to="/app/$organizationId/apps"
                params={{ organizationId }}
                className={buttonVariants({ variant: 'outline' })}
              >
                {m.home_notice_manage_connections()}
              </Link>
            ) : (
              <>
                <Link
                  to="/app/$organizationId/apps"
                  params={{ organizationId }}
                  search={{ install: 'shopify' }}
                  className={buttonVariants()}
                >
                  <Plug aria-hidden="true" />
                  {m.home_first_run_connect_shopify()}
                </Link>
                <Link
                  to="/app/$organizationId/apps"
                  params={{ organizationId }}
                  className={buttonVariants({ variant: 'ghost' })}
                >
                  {m.home_first_run_other_systems()}
                </Link>
              </>
            )}
          </div>
        ) : connected ? null : (
          <p className="home-first-run-ask">
            <strong>{m.home_first_run_ask_owner()}</strong>{' '}
            {m.home_first_run_ask_owner_description()}
          </p>
        )}
      </div>
      <ol
        className="home-first-run-steps"
        aria-label={m.home_first_run_steps_label()}
      >
        {steps.map((item) => (
          <li key={item.id} data-step={item.step}>
            <StateDot state={stepStates[item.step]} />
            <div>
              <strong>{item.title}</strong>
              <span className="home-first-run-state">
                {stepLabels[item.step]()}
              </span>
              <p>{item.description}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
