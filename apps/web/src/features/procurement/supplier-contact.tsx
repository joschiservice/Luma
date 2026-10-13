import type { Supplier } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useState } from 'react';

import { procurementError } from './data';
import { useCommand } from './forms';
import { updateSupplierContact } from './supplier-email-data';

/** Maintains explicit supplier correspondence details without changing provider observations. */
export function SupplierContact({
  organizationId,
  supplier,
  canManage,
}: {
  organizationId: string;
  supplier: Supplier;
  canManage: boolean;
}) {
  const [email, setEmail] = useState(supplier.email ?? '');
  const [language, setLanguage] = useState(supplier.language ?? '');
  const [saved, setSaved] = useState(false);
  const command = useCommand(
    organizationId,
    (body: Parameters<typeof updateSupplierContact>[2]) =>
      updateSupplierContact(organizationId, supplier.id, body),
    () => setSaved(true),
  );
  if (!canManage)
    return (
      <div>
        <p>{supplier.email ?? m.procurement_email_contact_missing()}</p>
        <p>
          {m.procurement_email_language()}:{' '}
          {supplier.language === 'de'
            ? m.procurement_email_language_de()
            : supplier.language === 'en'
              ? m.procurement_email_language_en()
              : m.procurement_email_language_unknown()}
        </p>
      </div>
    );

  return (
    <form
      className="procurement-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        command.submit({
          id: crypto.randomUUID(),
          expectedRevision: supplier.revision ?? 1,
          email: email || null,
          language: language === 'en' || language === 'de' ? language : null,
        });
      }}
    >
      <fieldset disabled={command.locked}>
        <label>
          {m.procurement_email_supplier_address()}
          <Input
            type="email"
            maxLength={320}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          {m.procurement_email_language()}
          <Select
            value={language}
            onValueChange={(value) => setLanguage(value ?? '')}
            options={[
              { value: '', label: m.procurement_email_language_unknown() },
              { value: 'en', label: m.procurement_email_language_en() },
              { value: 'de', label: m.procurement_email_language_de() },
            ]}
          />
        </label>
      </fieldset>
      {command.error ? (
        <Alert tone="danger" role="alert">
          {procurementError(command.error)}
        </Alert>
      ) : null}
      {saved ? (
        <p role="status">{m.procurement_email_contact_saved()}</p>
      ) : null}
      <Button type="submit" variant="outline" disabled={command.isPending}>
        {command.isPending
          ? m.common_saving()
          : command.uncertain
            ? m.common_retry()
            : m.common_save()}
      </Button>
    </form>
  );
}
