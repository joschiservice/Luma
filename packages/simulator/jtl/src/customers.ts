import {
  allocate,
  type CustomerRecord,
  iso,
  type JtlContext,
  kinds,
  refuse,
} from './records.js';
import type { JtlCustomerInput } from './types.js';

const text = (value: string | undefined, max = 255) =>
  value !== undefined && (!value.trim() || value.length > max);

/**
 * Returns the customer the order integration assigns an order to: the existing customer with
 * the same email address, case-insensitively, or a new one. A returning customer keeps their
 * stored details, as JTL does not update customers from later orders.
 */
export async function customerFor(
  context: JtlContext,
  input: JtlCustomerInput,
) {
  if (
    !/^[^\s@]+@[^\s@]+$/.test(input.email) ||
    input.email.length > 255 ||
    [
      input.firstName,
      input.lastName,
      input.street,
      input.city,
      input.postalCode,
    ].some((value) => text(value)) ||
    text(input.company) ||
    text(input.phone, 50) ||
    !/^[A-Z]{2}$/.test(input.countryIso)
  )
    refuse('Invalid customer');
  const key = input.email.toLowerCase();
  const existing = await context.store.page<CustomerRecord>({
    kind: kinds.customer,
    key,
    limit: 1,
  });
  if (existing.items[0]) return existing.items[0].id;

  const id = await allocate(context, kinds.customer);
  const at = iso(context.now);
  const customer: CustomerRecord = {
    id,
    number: `K${id.padStart(6, '0')}`,
    firstName: input.firstName,
    lastName: input.lastName,
    company: input.company ?? null,
    email: input.email,
    phone: input.phone ?? null,
    street: input.street,
    city: input.city,
    postalCode: input.postalCode,
    countryIso: input.countryIso,
    created: at,
    modified: at,
  };
  await context.store.put(kinds.customer, id, customer, {
    key,
    createdAt: context.now,
    updatedAt: context.now,
  });

  return id;
}

/** Serializes a customer overview row in ERP API 2.2 field names. */
export function customerJson(customer: CustomerRecord) {
  return {
    id: Number(customer.id),
    customerNumber: customer.number,
    firstName: customer.firstName,
    lastName: customer.lastName,
    companyName: customer.company,
    emailAddress: customer.email,
    phoneNumber: customer.phone,
    street: customer.street,
    postalCode: customer.postalCode,
    city: customer.city,
    countryIso: customer.countryIso,
    createdDate: customer.created,
    lastChanged: customer.modified,
    isLocked: false,
    hasNewsletter: false,
    isCashRegisterBased: false,
    isJtlFulfillment: false,
  };
}
