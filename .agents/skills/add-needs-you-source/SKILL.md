---
name: add-needs-you-source
description: Add a new kind of decision to the Needs you queue, from the owning domain's read through the decisions read model, the web owner review, live updates and tests. Use when a domain or app has decisions a person must make that should appear in Needs you, Home's attention module or the sidebar count.
---

# Adding a Needs you source

Needs you is a read projection: it lists decisions the reader can act on now, and every
response goes through the owner's own review. The queue never approves, rejects or runs
anything. Read [Needs you](../../../docs/needs-you.md) first; its rules for presentation,
`unknown` impact, response authority and departed items apply to every source.

Workspace apps don't need these steps: implement `decisions(context)` and declare
`decisionAccess` per kind, as the [app package contract](../../../docs/apps.md#app-package-contract)
describes.

1. **Read in the owner.** Keep the decision and its checks in the owning domain. Add a read
   that returns only decisions that need a person now, from persisted state, bounded in size.
   It must not call providers or models.
2. **Present it.** Give each decision a stable ID with a new prefix (`<source>:`), the
   reason, why a person is needed, what each response causes, the exact change, the deadline
   and evidence validity. Map it to the shared decision item in `@luma/read-models` and the
   contract in `packages/api-contract/src/decisions.ts`, and register the source in the
   decisions composition in `packages/application-runtime/src/composition/decisions.ts`.
3. **Mount the response.** Give it a `DecisionOwner` the web can mount and add a case to the
   owner review in `apps/web/src/features/decisions` if needed.
4. **Keep it live.** Add its tables to the metric notification triggers with the `decisions`
   topic, in a migration (see the [add-migration](../add-migration/SKILL.md) skill).
5. **Test it.** Cover the reader-specific `response`, removal after a response on another
   surface, the departed view, and tenant isolation in `apps/api/e2e/decisions.e2e.mjs` or the
   owner's suite. Add the source to the table in the Needs you guide.

Finish with the [verify-change](../verify-change/SKILL.md) skill.
