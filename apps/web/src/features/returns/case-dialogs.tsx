import type {
  DecisionEvidence,
  ResolutionKind,
  ReturnCaseDetail,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
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
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

import {
  caseCommands,
  creationChoicesOptions,
  returnCaseError,
  returnCaseKey,
  uncertainFailure,
} from './case-data';
import { reasonLabels, resolutionLabels } from './case-presentation';

/**
 * Runs a return case command and keeps an uncertain request's body for an exact retry. The
 * form locks while a request is pending or its outcome is unknown.
 */
export function useCaseCommand<T, R>(
  organizationId: string,
  save: (body: T) => Promise<R>,
  saved: (value: R) => void,
) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: (value) => {
      void client.invalidateQueries({
        queryKey: returnCaseKey(organizationId),
      });
      saved(value);
    },
  });
  const uncertain = mutation.isError && uncertainFailure(mutation.error);

  return {
    ...mutation,
    uncertain,
    locked: mutation.isPending || uncertain,
    submit: (body: T) =>
      mutation.mutate(uncertain ? mutation.variables! : body),
  };
}

type Command = ReturnType<typeof useCaseCommand>;

/** A dialog that can't close while its request is pending or uncertain. */
export function CaseDialog({
  title,
  description,
  command,
  close,
  submit,
  label,
  pending,
  disabled = false,
  children,
}: {
  title: string;
  description: ReactNode;
  command: Pick<Command, 'locked' | 'isPending' | 'uncertain' | 'error'>;
  close: () => void;
  submit: () => void;
  label: string;
  pending: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !command.locked) close();
      }}
    >
      <DialogContent
        showCloseButton={!command.locked}
        className="returns-case-dialog"
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <form
          className="returns-case-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <fieldset disabled={command.locked}>{children}</fieldset>
          {command.error ? (
            <Alert tone="danger" role="alert">
              {returnCaseError(command.error)}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={command.locked}
              onClick={close}
            >
              {m.common_cancel()}
            </Button>
            <Button type="submit" disabled={command.isPending || disabled}>
              {command.isPending
                ? pending
                : command.uncertain
                  ? m.common_retry()
                  : label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A whole-unit field for one line, bounded by `max`. */
export function UnitsField({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="returns-case-units">
      <span>{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        step={1}
        required
        value={String(value)}
        onChange={(event) => onChange(Math.trunc(Number(event.target.value)))}
      />
    </label>
  );
}

/** Optional note and link a decision rests on. */
function EvidenceFields({
  value,
  onChange,
}: {
  value: { note: string; link: string };
  onChange: (value: { note: string; link: string }) => void;
}) {
  return (
    <div className="returns-case-evidence">
      <label>
        {m.returns_case_evidence_note()} <span>{m.common_optional()}</span>
        <Textarea
          value={value.note}
          maxLength={2000}
          rows={3}
          onChange={(event) => onChange({ ...value, note: event.target.value })}
        />
      </label>
      <label>
        {m.returns_case_evidence_link()} <span>{m.common_optional()}</span>
        <Input
          type="url"
          value={value.link}
          maxLength={2000}
          placeholder="https://"
          onChange={(event) => onChange({ ...value, link: event.target.value })}
        />
      </label>
    </div>
  );
}

const evidence = (value: { note: string; link: string }): DecisionEvidence => ({
  note: value.note.trim() || null,
  link: value.link.trim() || null,
});

const lineName = (line: ReturnCaseDetail['lines'][number]) =>
  line.title ?? line.sku ?? m.returns_refunds_order_line();

/** The command fields every case change carries: a fresh ID and the reviewed revision. */
function useCommandId(detail: ReturnCaseDetail) {
  const [commandId] = useState(() => crypto.randomUUID());

  return { commandId, expectedRevision: detail.case.revision };
}

/** Records the units that physically arrived back for every line. */
export function ReceiptDialog({
  organizationId,
  detail,
  close,
}: {
  organizationId: string;
  detail: ReturnCaseDetail;
  close: () => void;
}) {
  const base = useCommandId(detail);
  const [received, setReceived] = useState(() =>
    detail.lines.map((line) => line.received ?? line.quantity),
  );
  const [proof, setProof] = useState({ note: '', link: '' });
  const commands = caseCommands(organizationId, detail.case.id);
  const command = useCaseCommand(organizationId, commands.receipt, close);

  return (
    <CaseDialog
      title={m.returns_case_receipt_title()}
      description={
        detail.inspection
          ? m.returns_case_receipt_description_replaces()
          : m.returns_case_receipt_description()
      }
      command={command}
      close={close}
      label={m.returns_case_receipt_save()}
      pending={m.returns_case_saving()}
      submit={() =>
        command.submit({
          ...base,
          lines: detail.lines.map((line, index) => ({
            orderLineId: line.orderLineId,
            received: received[index]!,
          })),
          evidence: evidence(proof),
        })
      }
    >
      <ul className="returns-case-lines">
        {detail.lines.map((line, index) => (
          <li key={line.orderLineId}>
            <span className="returns-cell">
              <strong>{lineName(line)}</strong>
              <small>
                {m.returns_case_line_requested({ units: line.quantity })}
              </small>
            </span>
            <UnitsField
              label={m.returns_case_receipt_received()}
              value={received[index]!}
              max={line.quantity}
              onChange={(value) =>
                setReceived((current) =>
                  current.map((v, i) => (i === index ? value : v)),
                )
              }
            />
          </li>
        ))}
      </ul>
      <EvidenceFields value={proof} onChange={setProof} />
    </CaseDialog>
  );
}

/** Judges every received unit as resellable or damaged. */
export function InspectionDialog({
  organizationId,
  detail,
  close,
}: {
  organizationId: string;
  detail: ReturnCaseDetail;
  close: () => void;
}) {
  const base = useCommandId(detail);
  const [judged, setJudged] = useState(() =>
    detail.lines.map((line) => ({
      resellable: line.resellable ?? line.received ?? 0,
      damaged: line.damaged ?? 0,
    })),
  );
  const [proof, setProof] = useState({ note: '', link: '' });
  const commands = caseCommands(organizationId, detail.case.id);
  const command = useCaseCommand(organizationId, commands.inspection, close);
  const balanced = detail.lines.every(
    (line, index) =>
      judged[index]!.resellable + judged[index]!.damaged ===
      (line.received ?? 0),
  );
  const update = (index: number, patch: Partial<(typeof judged)[number]>) =>
    setJudged((current) =>
      current.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    );

  return (
    <CaseDialog
      title={m.returns_case_inspection_title()}
      description={m.returns_case_inspection_description()}
      command={command}
      close={close}
      label={m.returns_case_inspection_save()}
      pending={m.returns_case_saving()}
      disabled={!balanced}
      submit={() =>
        command.submit({
          ...base,
          lines: detail.lines.map((line, index) => ({
            orderLineId: line.orderLineId,
            ...judged[index]!,
          })),
          evidence: evidence(proof),
        })
      }
    >
      <ul className="returns-case-lines">
        {detail.lines.map((line, index) => (
          <li key={line.orderLineId}>
            <span className="returns-cell">
              <strong>{lineName(line)}</strong>
              <small>
                {m.returns_case_line_received({
                  units: line.received ?? 0,
                  missing: line.missing ?? 0,
                })}
              </small>
            </span>
            <UnitsField
              label={m.returns_case_inspection_resellable()}
              value={judged[index]!.resellable}
              max={line.received ?? 0}
              onChange={(resellable) => update(index, { resellable })}
            />
            <UnitsField
              label={m.returns_case_inspection_damaged()}
              value={judged[index]!.damaged}
              max={line.received ?? 0}
              onChange={(damaged) => update(index, { damaged })}
            />
          </li>
        ))}
      </ul>
      {balanced ? null : (
        <p className="returns-note" role="status">
          {m.returns_case_inspection_unbalanced()}
        </p>
      )}
      <EvidenceFields value={proof} onChange={setProof} />
    </CaseDialog>
  );
}

/** Proposes how to settle the return and which resellable units to restock. */
export function ProposalDialog({
  organizationId,
  detail,
  close,
}: {
  organizationId: string;
  detail: ReturnCaseDetail;
  close: () => void;
}) {
  const base = useCommandId(detail);
  const [kind, setKind] = useState<ResolutionKind>(
    detail.proposal?.kind ?? 'refund',
  );
  const [restock, setRestock] = useState(() =>
    detail.lines.map((line) => line.restock ?? line.resellable ?? 0),
  );
  const [proof, setProof] = useState({ note: '', link: '' });
  const commands = caseCommands(organizationId, detail.case.id);
  const command = useCaseCommand(organizationId, commands.proposal, close);
  const rejection = kind === 'rejection';

  return (
    <CaseDialog
      title={m.returns_case_proposal_title()}
      description={m.returns_case_proposal_description()}
      command={command}
      close={close}
      label={m.returns_case_proposal_save()}
      pending={m.returns_case_saving()}
      submit={() =>
        command.submit({
          ...base,
          kind,
          lines: detail.lines.map((line, index) => ({
            orderLineId: line.orderLineId,
            restock: rejection ? 0 : restock[index]!,
          })),
          evidence: evidence(proof),
        })
      }
    >
      <label>
        {m.returns_case_proposal_kind()}
        <Select
          aria-label={m.returns_case_proposal_kind()}
          value={kind}
          onValueChange={(value) => setKind(value ?? 'refund')}
          options={(
            ['refund', 'exchange', 'store_credit', 'rejection'] as const
          ).map((value) => ({ value, label: resolutionLabels[value] }))}
        />
      </label>
      {rejection ? (
        <p className="returns-note">{m.returns_case_proposal_rejection()}</p>
      ) : (
        <ul className="returns-case-lines">
          {detail.lines.map((line, index) => (
            <li key={line.orderLineId}>
              <span className="returns-cell">
                <strong>{lineName(line)}</strong>
                <small>
                  {m.returns_case_line_judged({
                    resellable: line.resellable ?? 0,
                    damaged: line.damaged ?? 0,
                    missing: line.missing ?? 0,
                  })}
                </small>
              </span>
              <UnitsField
                label={m.returns_case_proposal_restock()}
                value={restock[index]!}
                max={line.resellable ?? 0}
                onChange={(value) =>
                  setRestock((current) =>
                    current.map((v, i) => (i === index ? value : v)),
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
      <p className="returns-note">{m.returns_case_proposal_only()}</p>
      <EvidenceFields value={proof} onChange={setProof} />
    </CaseDialog>
  );
}

/** Cancels the case with a reason; its units can be returned again. */
export function CancelDialog({
  organizationId,
  detail,
  close,
}: {
  organizationId: string;
  detail: ReturnCaseDetail;
  close: () => void;
}) {
  const base = useCommandId(detail);
  const [reason, setReason] = useState('');
  const commands = caseCommands(organizationId, detail.case.id);
  const command = useCaseCommand(organizationId, commands.cancel, close);

  return (
    <CaseDialog
      title={m.returns_case_cancel_title()}
      description={m.returns_case_cancel_description()}
      command={command}
      close={close}
      label={m.returns_case_cancel_save()}
      pending={m.returns_case_saving()}
      submit={() => command.submit({ ...base, reason: reason.trim() })}
    >
      <label>
        {m.returns_case_cancel_reason()}
        <Textarea
          required
          autoFocus
          value={reason}
          maxLength={500}
          rows={3}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
    </CaseDialog>
  );
}

/**
 * Asks for approval to create the case's return in the system its order came from. Lists
 * exactly what will be sent; someone else approves it.
 */
export function CreationDialog({
  organizationId,
  detail,
  system,
  close,
}: {
  organizationId: string;
  detail: ReturnCaseDetail;
  system: string;
  close: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const choices = useQuery(
    creationChoicesOptions(organizationId, detail.case.id),
  );
  const [warehouse, setWarehouse] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const commands = caseCommands(organizationId, detail.case.id);
  const command = useCaseCommand(
    organizationId,
    commands.requestCreation,
    close,
  );
  const key = (option: { externalId: string; scopeKey: string }) =>
    JSON.stringify([option.externalId, option.scopeKey]);
  const pick = <T extends { externalId: string; scopeKey: string }>(
    options: T[],
    value: string | null,
  ) => options.find((option) => key(option) === value);
  const warehouses = choices.data?.warehouses ?? [];
  const reasons = choices.data?.reasons ?? [];
  const chosenWarehouse = pick(warehouses, warehouse);
  const chosenReason = pick(reasons, reason);

  return (
    <CaseDialog
      title={m.returns_case_creation_dialog_title({ system })}
      description={m.returns_case_creation_dialog_description({ system })}
      command={command}
      close={close}
      label={m.returns_case_creation_request()}
      pending={m.returns_case_creation_requesting()}
      disabled={!chosenWarehouse || !chosenReason}
      submit={() =>
        chosenWarehouse && chosenReason
          ? command.submit({
              id,
              warehouse: {
                externalId: chosenWarehouse.externalId,
                scopeKey: chosenWarehouse.scopeKey,
              },
              reason: {
                externalId: chosenReason.externalId,
                scopeKey: chosenReason.scopeKey,
              },
            })
          : undefined
      }
    >
      {choices.isPending ? (
        <p className="returns-note" role="status">
          {m.returns_case_creation_loading({ system })}
        </p>
      ) : choices.error ? (
        <Alert tone="danger" role="alert">
          {returnCaseError(choices.error)}
        </Alert>
      ) : (
        <>
          <label>
            {m.returns_case_creation_warehouse()}
            <Select
              aria-label={m.returns_case_creation_warehouse()}
              value={warehouse}
              placeholder={m.returns_case_creation_choose()}
              onValueChange={setWarehouse}
              options={warehouses.map((option) => ({
                value: key(option),
                label: option.name ?? option.externalId,
              }))}
            />
          </label>
          <label>
            {m.returns_case_creation_reason()}
            <Select
              aria-label={m.returns_case_creation_reason()}
              value={reason}
              placeholder={m.returns_case_creation_choose()}
              onValueChange={setReason}
              options={reasons.map((option) => ({
                value: key(option),
                label: option.name ?? option.externalId,
              }))}
            />
          </label>
        </>
      )}
      <div className="returns-case-summary">
        <h3>{m.returns_case_creation_summary()}</h3>
        <ul>
          {detail.lines.map((line) => (
            <li key={line.orderLineId}>
              <strong>{formatNumber(line.quantity)}</strong> {lineName(line)}{' '}
              <small>· {reasonLabels[line.reason]}</small>
            </li>
          ))}
        </ul>
        <p className="returns-note">
          {m.returns_case_creation_no_credit({ system })}
        </p>
      </div>
    </CaseDialog>
  );
}
