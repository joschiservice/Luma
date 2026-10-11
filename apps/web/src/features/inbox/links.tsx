import type { LinkedRecordKind, ThreadLink } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Link2, Plus } from 'lucide-react';
import { useContext, useEffect, useId, useState } from 'react';
import { z } from 'zod';

import { customersOptions } from '../customers/data';
import { usePermissions } from '../identity/permissions';
import { ordersOptions as commerceOrdersOptions } from '../orders/data';
import {
  ordersOptions as purchaseOrdersOptions,
  suppliersOptions,
} from '../procurement/data';
import { CommandFeedback } from './command-feedback';
import { linkRecord, unlinkRecord, useInboxCommand } from './data';
import {
  linkMethodLabels,
  recordKindLabels,
  recordKinds,
} from './presentation';
import { RecordLink } from './records';

/** The permission needed to find records of each kind. */
export const recordReadPermissions: Record<LinkedRecordKind, string> = {
  order: 'orders.read',
  customer: 'customers.read',
  supplier: 'procurement.read',
  purchase_order: 'procurement.read',
  case: 'issues.read',
};

/** Records the thread is linked to, suggestions waiting for confirmation, and link controls. */
export function LinkedRecords({
  organizationId,
  threadId,
  links,
  manage,
  people,
}: {
  organizationId: string;
  threadId: string;
  links: readonly ThreadLink[];
  manage: boolean;
  people: { name: (id: string) => string };
}) {
  const [adding, setAdding] = useState(false);
  const active = links.filter((link) => link.state === 'active');
  const suggested = links.filter((link) => link.state === 'suggested');

  return (
    <section className="messaging-section" aria-labelledby="thread-links">
      <div className="messaging-section-heading">
        <h3 id="thread-links">{m.messaging_links_title()}</h3>
        {manage ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {m.messaging_links_add()}
          </Button>
        ) : null}
      </div>
      {active.length ? (
        <ul className="messaging-links">
          {active.map((link) => (
            <LinkItem
              key={link.id}
              organizationId={organizationId}
              threadId={threadId}
              link={link}
              manage={manage}
              people={people}
            />
          ))}
        </ul>
      ) : (
        <p className="messaging-muted">{m.messaging_links_empty()}</p>
      )}
      {suggested.length ? (
        <>
          <h4 className="messaging-subheading">
            {m.messaging_links_suggested_title()}
          </h4>
          <p className="messaging-muted">
            {m.messaging_links_suggested_text()}
          </p>
          <ul className="messaging-links">
            {suggested.map((link) => (
              <LinkItem
                key={link.id}
                organizationId={organizationId}
                threadId={threadId}
                link={link}
                manage={manage}
                people={people}
              />
            ))}
          </ul>
        </>
      ) : null}
      {adding ? (
        <AddLinkDialog
          organizationId={organizationId}
          threadId={threadId}
          close={() => setAdding(false)}
        />
      ) : null}
    </section>
  );
}

function LinkItem({
  organizationId,
  threadId,
  link,
  manage,
  people,
}: {
  organizationId: string;
  threadId: string;
  link: ThreadLink;
  manage: boolean;
  people: { name: (id: string) => string };
}) {
  const org = { organizationId };
  const confirm = useInboxCommand(organizationId, (_: null, id) =>
    linkRecord(org, threadId, {
      id,
      kind: link.record.kind,
      recordId: link.record.id,
    }),
  );
  const remove = useInboxCommand(organizationId, (_: null, id) =>
    unlinkRecord(org, threadId, link.id, id),
  );
  const locked = confirm.locked || remove.locked;

  return (
    <li className="messaging-link" data-state={link.state}>
      <div className="messaging-link-main">
        <RecordLink organizationId={organizationId} record={link.record} />
        <Badge>{linkMethodLabels[link.method]()}</Badge>
        {link.state === 'suggested' ? (
          <Badge tone="warning">{m.messaging_link_suggested()}</Badge>
        ) : null}
      </div>
      <p className="messaging-muted">
        {link.evidence.text
          ? m.messaging_link_evidence({ text: link.evidence.text })
          : link.method === 'manual'
            ? m.messaging_link_manual_by({ name: people.name(link.createdBy) })
            : m.messaging_link_evidence_none()}
      </p>
      {manage ? (
        <div className="messaging-inline-actions">
          {link.state === 'suggested' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => confirm.submit(null)}
            >
              {m.messaging_link_confirm()}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => remove.submit(null)}
          >
            {link.state === 'suggested'
              ? m.messaging_link_dismiss()
              : m.messaging_link_remove()}
          </Button>
        </div>
      ) : null}
      <CommandFeedback command={confirm} />
      <CommandFeedback command={remove} />
    </li>
  );
}

type Candidate = { id: string; label: string; detail?: string | undefined };

function useDebounced(value: string, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);

    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

const contains = (text: string | null | undefined, query: string) =>
  !!text && text.toLowerCase().includes(query.toLowerCase());

/**
 * Finds records of one kind by a typed search over the lists the reader can already read: orders
 * and customers search on the server; suppliers and purchase orders filter the workspace lists.
 * Cases are linked by their ID.
 */
function useCandidates(
  organizationId: string,
  kind: LinkedRecordKind,
  query: string,
  allowed: boolean,
) {
  const timeZone = useContext(WorkspaceTimezone);
  const q = query.trim();
  const orders = useQuery({
    ...commerceOrdersOptions(organizationId, { q }, timeZone),
    enabled: allowed && kind === 'order' && q.length > 0,
  });
  const customers = useQuery({
    ...customersOptions(organizationId, {}, q),
    enabled: allowed && kind === 'customer' && q.length > 0,
  });
  const suppliers = useQuery({
    ...suppliersOptions(organizationId),
    enabled: allowed && kind === 'supplier',
  });
  const purchaseOrders = useQuery({
    ...purchaseOrdersOptions(organizationId),
    enabled: allowed && kind === 'purchase_order',
  });

  const result = (
    items: Candidate[] | undefined,
    state: { isFetching: boolean; isError: boolean },
  ) => ({
    items: items?.slice(0, 20),
    loading: state.isFetching,
    failed: state.isError,
  });

  switch (kind) {
    case 'order':
      return result(
        q
          ? orders.data?.items.map((order) => ({
              id: order.id,
              label: order.displayNumber ?? order.id,
              detail: order.sources.map((source) => source.label).join(', '),
            }))
          : [],
        orders,
      );
    case 'customer':
      return result(
        q
          ? customers.data?.items.map((customer) => ({
              id: customer.id,
              label: customer.displayName ?? customer.email ?? customer.id,
              detail: customer.displayName
                ? (customer.email ?? undefined)
                : undefined,
            }))
          : [],
        customers,
      );
    case 'supplier':
      return result(
        suppliers.data?.items
          .filter((supplier) => !q || contains(supplier.name, q))
          .map((supplier) => ({ id: supplier.id, label: supplier.name })),
        suppliers,
      );
    case 'purchase_order':
      return result(
        purchaseOrders.data?.items
          .filter(
            (order) =>
              !q ||
              contains(order.reference, q) ||
              contains(order.supplierName, q),
          )
          .map((order) => ({
            id: order.id,
            label: order.reference,
            detail: order.supplierName,
          })),
        purchaseOrders,
      );
    case 'case':
      return result(
        z.string().uuid().safeParse(q).success ? [{ id: q, label: q }] : [],
        { isFetching: false, isError: false },
      );
  }
}

/** Links the thread to a record found by kind and search; the command ID makes retries safe. */
function AddLinkDialog({
  organizationId,
  threadId,
  close,
}: {
  organizationId: string;
  threadId: string;
  close: () => void;
}) {
  const { can } = usePermissions(organizationId);
  const kindId = useId();
  const searchId = useId();
  const [kind, setKind] = useState<LinkedRecordKind>('order');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string>();
  const allowed = can(recordReadPermissions[kind]);
  const candidates = useCandidates(
    organizationId,
    kind,
    useDebounced(query),
    allowed,
  );
  const command = useInboxCommand(
    organizationId,
    (body: { kind: LinkedRecordKind; recordId: string }, id) =>
      linkRecord({ organizationId }, threadId, { id, ...body }),
    close,
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) close();
      }}
    >
      <DialogContent showCloseButton={!command.locked}>
        <DialogTitle>{m.messaging_link_dialog_title()}</DialogTitle>
        <DialogDescription>{m.messaging_link_dialog_text()}</DialogDescription>
        <form
          className="messaging-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen) command.submit({ kind, recordId: chosen });
          }}
        >
          <fieldset disabled={command.locked}>
            <div className="messaging-field">
              <span id={kindId}>{m.messaging_link_dialog_kind()}</span>
              <Select
                aria-labelledby={kindId}
                value={kind}
                onValueChange={(value) => {
                  if (!value) return;
                  setKind(value);
                  setChosen(undefined);
                }}
                options={recordKinds.map((value) => ({
                  value,
                  label: recordKindLabels[value](),
                }))}
              />
            </div>
            <label className="messaging-field" htmlFor={searchId}>
              {kind === 'case'
                ? m.messaging_link_dialog_case_id()
                : m.messaging_link_dialog_search()}
              <Input
                id={searchId}
                autoFocus
                value={query}
                maxLength={200}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setChosen(undefined);
                }}
                placeholder={
                  kind === 'case'
                    ? m.messaging_link_dialog_case_placeholder()
                    : m.messaging_link_dialog_search_placeholder()
                }
              />
            </label>
            {!allowed ? (
              <Alert tone="warning">
                {m.messaging_link_dialog_no_access({
                  kind: recordKindLabels[kind](),
                })}
              </Alert>
            ) : candidates.failed ? (
              <Alert tone="danger">{m.messaging_link_dialog_failed()}</Alert>
            ) : candidates.loading ? (
              <p role="status" className="messaging-muted">
                {m.messaging_link_dialog_searching()}
              </p>
            ) : candidates.items?.length ? (
              <fieldset className="messaging-candidates">
                <legend className="sr-only">
                  {m.messaging_link_dialog_results()}
                </legend>
                {candidates.items.map((candidate) => (
                  <label key={candidate.id}>
                    <input
                      type="radio"
                      name="record"
                      value={candidate.id}
                      checked={chosen === candidate.id}
                      onChange={() => setChosen(candidate.id)}
                    />
                    <span>{candidate.label}</span>
                    {candidate.detail ? (
                      <small className="messaging-muted">
                        {candidate.detail}
                      </small>
                    ) : null}
                  </label>
                ))}
              </fieldset>
            ) : query.trim() ||
              kind === 'supplier' ||
              kind === 'purchase_order' ? (
              <p className="messaging-muted">
                {kind === 'case'
                  ? m.messaging_link_dialog_case_invalid()
                  : m.messaging_link_dialog_none()}
              </p>
            ) : null}
          </fieldset>
          <CommandFeedback command={command} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={command.locked}
              onClick={close}
            >
              {m.common_cancel()}
            </Button>
            <Button
              type="submit"
              disabled={command.isPending || (!chosen && !command.uncertain)}
            >
              <Link2 aria-hidden="true" />
              {command.isPending
                ? m.common_saving()
                : command.uncertain
                  ? m.messaging_retry_same()
                  : m.messaging_link_dialog_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
