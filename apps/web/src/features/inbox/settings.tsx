import './inbox.css';

import {
  type Mailbox,
  type MailboxRule,
  mailboxRuleInputSchema,
  type MailboxRuleKind,
  type RuleParty,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Input } from '@luma/ui/components/primitives/input';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { Switch } from '@luma/ui/components/primitives/switch';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { RecordHeader } from '@luma/ui/components/workspace/record-header';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Mail, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';

import { SignInRedirect } from '../identity/common';
import { usePermissions } from '../identity/permissions';
import { suppliersOptions } from '../procurement/data';
import { CommandFeedback } from './command-feedback';
import {
  addRule,
  mailboxesOptions,
  readFailure,
  removeRule,
  syncMailbox,
  updateMailbox,
  useInboxCommand,
} from './data';
import { useInboxUpdates } from './live';
import {
  connectionLabels,
  partyKinds,
  partyLabels,
  ruleKindHints,
  ruleKindLabels,
  ruleKinds,
  syncStateLabels,
  syncStates,
} from './presentation';

/** Loads the workspace's mailboxes and their rules for the mailbox settings page. */
export function InboxSettingsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/inbox/settings',
  });
  useInboxUpdates(organizationId);
  const query = useQuery(mailboxesOptions(organizationId));
  const { can } = usePermissions(organizationId);
  const failure = readFailure(query.error);
  if (failure === 'signin') return <SignInRedirect />;

  return (
    <MailboxSettingsView
      organizationId={organizationId}
      mailboxes={failure === 'access' ? undefined : query.data?.items}
      manage={!!query.data?.canManage && can('messages.manage')}
      loading={query.isPending}
      refreshing={query.isFetching}
      error={
        failure === 'access'
          ? m.messaging_error_access()
          : failure
            ? m.messaging_error_unavailable()
            : undefined
      }
      refresh={() => void query.refetch()}
    />
  );
}

/** Presents each mailbox's reading state, settings and the rules that decide what Luma reads. */
export function MailboxSettingsView({
  organizationId,
  mailboxes,
  manage,
  loading = false,
  refreshing = false,
  error,
  refresh,
}: {
  organizationId: string;
  mailboxes: readonly Mailbox[] | undefined;
  manage: boolean;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | undefined;
  refresh: () => void;
}) {
  return (
    <div className="messaging-page">
      <RecordHeader
        section={{
          label: m.messaging_page_title(),
          icon: Mail,
          link: (
            <Link to="/app/$organizationId/inbox" params={{ organizationId }} />
          ),
        }}
        title={m.messaging_settings_title()}
        description={m.messaging_settings_description()}
        actions={
          <RefreshButton
            refreshing={refreshing}
            onClick={refresh}
            label={m.messaging_refresh()}
          />
        }
      />
      {error ? (
        <Alert tone="danger" role="alert">
          {mailboxes ? `${m.messaging_list_stale()} ` : ''}
          {error}
        </Alert>
      ) : null}
      {loading && !error ? (
        <div className="messaging-loading" role="status">
          <span className="sr-only">{m.messaging_loading_settings()}</span>
          <span className="lu-skeleton" />
          <span className="lu-skeleton" />
        </div>
      ) : null}
      {mailboxes?.length === 0 ? (
        <Empty>
          <Mail aria-hidden="true" />
          <h2>{m.messaging_connect_title()}</h2>
          <p>{m.messaging_connect_text()}</p>
          <Link
            className={buttonVariants({ variant: 'outline' })}
            to="/app/$organizationId/apps"
            params={{ organizationId }}
          >
            {m.messaging_connect_action()}
          </Link>
        </Empty>
      ) : null}
      {mailboxes?.map((mailbox) => (
        <MailboxCard
          key={mailbox.connectionId}
          organizationId={organizationId}
          mailbox={mailbox}
          manage={manage}
        />
      ))}
    </div>
  );
}

function MailboxCard({
  organizationId,
  mailbox,
  manage,
}: {
  organizationId: string;
  mailbox: Mailbox;
  manage: boolean;
}) {
  const sync = useInboxCommand(organizationId, () =>
    syncMailbox({ organizationId }, mailbox.connectionId),
  );
  const title = mailbox.address ?? mailbox.label;

  return (
    <Card as="section" aria-label={title} className="messaging-mailbox">
      <CardHeader>
        <div>
          <CardTitle as="h2">
            <Mail aria-hidden="true" />
            {title}
          </CardTitle>
          <CardDescription>
            {m.messaging_mailbox_provider({
              provider: mailbox.provider,
              connection: mailbox.label,
            })}
          </CardDescription>
        </div>
        {manage ? (
          <Button
            size="sm"
            variant="outline"
            disabled={sync.locked || mailbox.state === 'paused'}
            onClick={() => sync.submit(undefined)}
          >
            <RefreshCw aria-hidden="true" />
            {sync.isPending
              ? m.messaging_mailbox_reading()
              : m.messaging_mailbox_read_now()}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="messaging-mailbox-state">
          <StatePill state={syncStates[mailbox.state]}>
            {syncStateLabels[mailbox.state]()}
          </StatePill>
          {mailbox.stateReason ? <span>{mailbox.stateReason}</span> : null}
        </div>
        <CommandFeedback command={sync} />
        <dl className="messaging-facts">
          <div>
            <dt>{m.messaging_mailbox_last_read()}</dt>
            <dd>
              {mailbox.lastSyncedAt ? (
                <WorkspaceDate value={mailbox.lastSyncedAt} />
              ) : (
                m.messaging_mailbox_never()
              )}
            </dd>
          </div>
          <div>
            <dt>{m.messaging_mailbox_covered()}</dt>
            <dd>
              {mailbox.coveredUntil ? (
                <WorkspaceDate value={mailbox.coveredUntil} />
              ) : (
                m.messaging_mailbox_never()
              )}
            </dd>
          </div>
          <div>
            <dt>{m.messaging_mailbox_connection()}</dt>
            <dd>{connectionLabels[mailbox.connectionStatus]()}</dd>
          </div>
          <div>
            <dt>{m.messaging_mailbox_sending()}</dt>
            <dd>
              {mailbox.canSend
                ? m.messaging_mailbox_can_send()
                : m.messaging_mailbox_cannot_send()}
            </dd>
          </div>
        </dl>
        <SettingsForm
          key={mailbox.revision}
          organizationId={organizationId}
          mailbox={mailbox}
          manage={manage}
        />
        <Rules
          organizationId={organizationId}
          mailbox={mailbox}
          manage={manage}
        />
      </CardContent>
    </Card>
  );
}

function SettingsForm({
  organizationId,
  mailbox,
  manage,
}: {
  organizationId: string;
  mailbox: Mailbox;
  manage: boolean;
}) {
  const id = useId();
  const [settings, setSettings] = useState(mailbox.settings);
  const save = useInboxCommand(organizationId, (body: typeof settings) =>
    updateMailbox({ organizationId }, mailbox.connectionId, {
      ...body,
      expectedRevision: mailbox.revision,
    }),
  );
  const changed = JSON.stringify(settings) !== JSON.stringify(mailbox.settings);

  return (
    <form
      className="messaging-settings"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        save.submit(settings);
      }}
    >
      <h3 id={`${id}-title`}>{m.messaging_settings_section()}</h3>
      <fieldset disabled={!manage || save.locked}>
        <label className="messaging-field" htmlFor={`${id}-backfill`}>
          {m.messaging_settings_backfill()}
          <Input
            id={`${id}-backfill`}
            type="number"
            min={1}
            max={365}
            required
            value={settings.backfillDays}
            onChange={(event) =>
              setSettings({
                ...settings,
                backfillDays: Number(event.target.value),
              })
            }
          />
          <small>{m.messaging_settings_backfill_hint()}</small>
        </label>
        <label className="messaging-field" htmlFor={`${id}-reply`}>
          {m.messaging_settings_reply_hours()}
          <Input
            id={`${id}-reply`}
            type="number"
            min={1}
            max={720}
            required
            value={settings.replyHours}
            onChange={(event) =>
              setSettings({
                ...settings,
                replyHours: Number(event.target.value),
              })
            }
          />
          <small>{m.messaging_settings_reply_hours_hint()}</small>
        </label>
        <label className="messaging-switch">
          <Switch
            checked={settings.approveAll}
            onCheckedChange={(approveAll) =>
              setSettings({ ...settings, approveAll })
            }
          />
          <span>
            {m.messaging_settings_approve_all()}
            <small>{m.messaging_settings_approve_all_hint()}</small>
          </span>
        </label>
        <label className="messaging-switch">
          <Switch
            checked={settings.paused}
            onCheckedChange={(paused) => setSettings({ ...settings, paused })}
          />
          <span>
            {m.messaging_settings_paused()}
            <small>{m.messaging_settings_paused_hint()}</small>
          </span>
        </label>
      </fieldset>
      <CommandFeedback command={save} />
      {manage ? (
        <Button type="submit" size="sm" disabled={save.locked || !changed}>
          {save.isPending ? m.common_saving() : m.messaging_settings_save()}
        </Button>
      ) : null}
    </form>
  );
}

/** Groups rules by who the correspondent is: each supplier, customers, and others. */
export function groupRules(rules: readonly MailboxRule[]) {
  const groups = new Map<
    string,
    { key: string; label: string; rules: MailboxRule[] }
  >();
  for (const rule of rules) {
    const key =
      rule.party.kind === 'supplier'
        ? `supplier:${rule.party.supplierId}`
        : rule.party.kind;
    const label =
      rule.party.kind === 'supplier'
        ? m.messaging_rule_group_supplier({
            name: rule.partyLabel ?? m.messaging_rule_supplier_missing(),
          })
        : partyLabels[rule.party.kind]();
    const group = groups.get(key) ?? { key, label, rules: [] };
    group.rules.push(rule);
    groups.set(key, group);
  }

  return [...groups.values()].sort(
    (a, b) =>
      Number(b.key.startsWith('supplier:')) -
        Number(a.key.startsWith('supplier:')) || a.label.localeCompare(b.label),
  );
}

function Rules({
  organizationId,
  mailbox,
  manage,
}: {
  organizationId: string;
  mailbox: Mailbox;
  manage: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const id = useId();

  return (
    <section className="messaging-rules" aria-labelledby={`${id}-rules`}>
      <div className="messaging-section-heading">
        <h3 id={`${id}-rules`}>{m.messaging_rules_title()}</h3>
        {manage && !adding ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {m.messaging_rules_add()}
          </Button>
        ) : null}
      </div>
      <p className="messaging-muted">{m.messaging_rules_privacy()}</p>
      {mailbox.rules.length ? (
        groupRules(mailbox.rules).map((group) => (
          <div key={group.key} className="messaging-rule-group">
            <h4 className="messaging-subheading">{group.label}</h4>
            <ul className="messaging-rule-list">
              {group.rules.map((rule) => (
                <RuleItem
                  key={rule.id}
                  organizationId={organizationId}
                  connectionId={mailbox.connectionId}
                  rule={rule}
                  manage={manage}
                />
              ))}
            </ul>
          </div>
        ))
      ) : (
        <Alert tone="warning">{m.messaging_rules_empty()}</Alert>
      )}
      {adding ? (
        <RuleForm
          organizationId={organizationId}
          connectionId={mailbox.connectionId}
          close={() => setAdding(false)}
        />
      ) : null}
    </section>
  );
}

function RuleItem({
  organizationId,
  connectionId,
  rule,
  manage,
}: {
  organizationId: string;
  connectionId: string;
  rule: MailboxRule;
  manage: boolean;
}) {
  const remove = useInboxCommand(organizationId, (_: null, id) =>
    removeRule({ organizationId }, connectionId, rule.id, id),
  );

  return (
    <li>
      <div className="messaging-rule">
        <Badge>{ruleKindLabels[rule.kind]()}</Badge>
        <code>{rule.value}</code>
        <span className="messaging-muted">
          {rule.backfilledAt ? (
            <>
              {m.messaging_rule_backfilled()}{' '}
              <WorkspaceDate value={rule.backfilledAt} />
            </>
          ) : (
            m.messaging_rule_backfilling()
          )}
        </span>
        {manage ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.locked}
            aria-label={m.messaging_rule_remove_label({ value: rule.value })}
            onClick={() => remove.submit(null)}
          >
            <Trash2 aria-hidden="true" />
            {m.messaging_rule_remove()}
          </Button>
        ) : null}
      </div>
      <CommandFeedback command={remove} />
    </li>
  );
}

function RuleForm({
  organizationId,
  connectionId,
  close,
}: {
  organizationId: string;
  connectionId: string;
  close: () => void;
}) {
  const id = useId();
  const { can } = usePermissions(organizationId);
  const canReadSuppliers = can('procurement.read');
  const suppliers = useQuery({
    ...suppliersOptions(organizationId),
    enabled: canReadSuppliers,
  });
  const [kind, setKind] = useState<MailboxRuleKind>('sender_domain');
  const [value, setValue] = useState('');
  const [party, setParty] = useState<RuleParty['kind']>('supplier');
  const [supplierId, setSupplierId] = useState('');
  const [invalid, setInvalid] = useState<string>();
  // The rule ID doubles as the command ID: retrying the same rule never adds it twice.
  const [ruleId] = useState(() => crypto.randomUUID());
  const add = useInboxCommand(
    organizationId,
    (body: Parameters<typeof addRule>[2]) =>
      addRule({ organizationId }, connectionId, body),
    close,
  );
  const parties = partyKinds.filter(
    (option) => kind !== 'label' || option !== 'supplier',
  );
  const effectiveParty = parties.includes(party) ? party : 'other';

  return (
    <form
      className="messaging-form messaging-rule-form"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = mailboxRuleInputSchema.safeParse({
          id: ruleId,
          kind,
          value,
          party:
            effectiveParty === 'supplier'
              ? { kind: 'supplier', supplierId }
              : { kind: effectiveParty },
        });
        if (!parsed.success) {
          setInvalid(
            effectiveParty === 'supplier' && !supplierId
              ? m.messaging_rule_supplier_required()
              : m.messaging_rule_invalid({ kind: ruleKindLabels[kind]() }),
          );

          return;
        }
        setInvalid(undefined);
        add.submit(parsed.data);
      }}
    >
      <h4 id={`${id}-title`} className="messaging-subheading">
        {m.messaging_rules_add()}
      </h4>
      <fieldset disabled={add.locked}>
        <div className="messaging-field">
          <span id={`${id}-kind`}>{m.messaging_rule_kind()}</span>
          <Select
            aria-labelledby={`${id}-kind`}
            value={kind}
            onValueChange={(next) => next && setKind(next)}
            options={ruleKinds.map((option) => ({
              value: option,
              label: ruleKindLabels[option](),
            }))}
          />
        </div>
        <label className="messaging-field" htmlFor={`${id}-value`}>
          {m.messaging_rule_value()}
          <Input
            id={`${id}-value`}
            required
            autoFocus
            maxLength={320}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <small>{ruleKindHints[kind]()}</small>
        </label>
        <div className="messaging-field">
          <span id={`${id}-party`}>{m.messaging_rule_party()}</span>
          <Select
            aria-labelledby={`${id}-party`}
            value={effectiveParty}
            onValueChange={(next) => next && setParty(next)}
            options={parties.map((option) => ({
              value: option,
              label: partyLabels[option](),
            }))}
          />
        </div>
        {effectiveParty === 'supplier' ? (
          canReadSuppliers ? (
            <div className="messaging-field">
              <span id={`${id}-supplier`}>{m.messaging_rule_supplier()}</span>
              <Select
                aria-labelledby={`${id}-supplier`}
                value={supplierId || null}
                placeholder={
                  suppliers.isPending
                    ? m.messaging_rule_suppliers_loading()
                    : m.messaging_rule_supplier_choose()
                }
                onValueChange={(next) => setSupplierId(next ?? '')}
                options={(suppliers.data?.items ?? []).map((supplier) => ({
                  value: supplier.id,
                  label: supplier.name,
                }))}
              />
              {suppliers.isError ? (
                <small role="alert">
                  {m.messaging_rule_suppliers_failed()}
                </small>
              ) : null}
            </div>
          ) : (
            <Alert tone="warning">
              {m.messaging_rule_suppliers_no_access()}
            </Alert>
          )
        ) : null}
      </fieldset>
      <p className="messaging-muted">{m.messaging_rule_reads_hint()}</p>
      {invalid ? (
        <p className="messaging-error" role="alert">
          {invalid}
        </p>
      ) : null}
      <CommandFeedback command={add} />
      <div className="messaging-inline-actions">
        <Button type="submit" size="sm" disabled={add.isPending}>
          {add.isPending
            ? m.common_saving()
            : add.uncertain
              ? m.messaging_retry_same()
              : m.messaging_rule_add_submit()}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={add.locked}
          onClick={close}
        >
          {m.common_cancel()}
        </Button>
      </div>
    </form>
  );
}
