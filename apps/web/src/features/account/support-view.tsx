import type { SupportViewState } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { EntryFrame, Pending } from '../../kit/identity/common';
import {
  clearPrivate,
  endSupportView,
  IdentityError,
  redeemSupportView,
  rememberEndedSupportView,
  takeEndedSupportView,
} from '../../kit/identity/data';

const endReasons: Record<string, () => string> = {
  ended: m.identity_support_view_ended_by_you,
  expired: m.identity_support_view_ended_expired,
  consent_revoked: m.identity_support_view_ended_consent,
  staff_access_revoked: m.identity_support_view_ended_staff,
  replaced: m.identity_support_view_ended_replaced,
};

/**
 * Opens a Luma support view from a staff console link: exchanges the single-use token in the
 * URL fragment for the support view cookie, then opens the workspace. Without a token it
 * explains why a view ended, or that there is none.
 */
export function SupportViewEntry() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const started = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [ended] = useState(() => (hash ? null : takeEndedSupportView()));
  const token = /(?:^|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash)?.[1];

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    void (async () => {
      try {
        const view = await redeemSupportView(token);
        // Nothing from a customer session in this tab may leak into the view.
        await clearPrivate(client);
        await navigate({
          to: '/app/$organizationId/home',
          params: { organizationId: view.workspaceId },
          hash: '',
          replace: true,
        });
      } catch (error) {
        setFailed(
          error instanceof IdentityError && error.status === 404
            ? m.identity_support_view_link_used()
            : m.identity_support_view_link_failed(),
        );
      }
    })();
  }, [client, navigate, token]);

  if (token && !failed) return <Pending />;

  return (
    <EntryFrame>
      <section className="status-panel">
        <h1>
          {failed
            ? m.identity_support_view_link_title()
            : ended
              ? m.identity_support_view_ended_title()
              : m.identity_support_view_none_title()}
        </h1>
        <p role="status">
          {failed ??
            (ended
              ? (endReasons[ended] ?? m.identity_support_view_ended_expired)()
              : m.identity_support_view_none_body())}
        </p>
        <p>{m.identity_support_view_close_tab()}</p>
      </section>
    </EntryFrame>
  );
}

/** Ends this browser's support view, clears its data and shows that it ended. */
export function useEndSupportView() {
  const client = useQueryClient();
  const [ending, setEnding] = useState(false);
  const [failed, setFailed] = useState(false);

  async function end() {
    setEnding(true);
    setFailed(false);
    try {
      await endSupportView();
      rememberEndedSupportView('ended');
      await clearPrivate(client);
      window.location.replace('/support-view');
    } catch {
      setFailed(true);
      setEnding(false);
    }
  }

  return { end, ending, failed };
}

/**
 * States, on every workspace page of a support view, whose access it shows, that nothing can be
 * changed and when it ends, and lets staff end it.
 */
export function SupportViewBanner({
  view,
}: {
  view: Extract<SupportViewState, { active: true }>;
}) {
  const { end, ending, failed } = useEndSupportView();

  return (
    <div
      className="support-view-banner"
      role="region"
      aria-label={m.identity_support_view_banner_label()}
    >
      <Alert tone={view.mode === 'emergency' ? 'danger' : 'warning'}>
        <AlertTitle>
          {view.mode === 'emergency'
            ? m.identity_support_view_banner_emergency_title()
            : m.identity_support_view_banner_title()}
        </AlertTitle>
        <AlertDescription>
          <span>
            {m.identity_support_view_banner_body({
              name: view.member.name,
              workspace: view.workspace.name,
            })}{' '}
            {m.identity_support_view_banner_ends()}{' '}
            <WorkspaceDate value={view.expiresAt} />
          </span>
          {failed ? (
            <span role="alert">{m.identity_support_view_end_failed()}</span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={ending}
            onClick={() => void end()}
          >
            {m.identity_support_view_end()}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
