# @luma/customers

Owns imported customer profiles, the current profile each connection reports for a source customer, and order links: which source customer placed each source order.

Profiles and links keep only the latest accepted source version and are kept out of observations, so erasure removes the data completely. They are never merged across connections; names and email addresses do not establish identity. Provider payload translation belongs to connections and scheduling to commerce-sync.

## Public entry points

- `@luma/customers`
- `@luma/customers/composition`

## Further reading

- [Commerce sync](../../docs/commerce-sync.md)
