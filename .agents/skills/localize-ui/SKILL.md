---
name: localize-ui
description: Add or change user-facing interface text in Luma's English and German message catalogs, format numbers and dates, localize server-provided catalogs, or add an interface language. Use whenever a change adds or edits visible text in the web app, a workspace app UI, shared components or emails.
---

# Localizing interface text

All visible interface text lives in the `@luma/i18n` catalogs, written in English and German
in the same change. Paraglide compiles them into typed message functions, so a missing key or
placeholder is a type error. Read the message rules in
[localization](../../../docs/localization.md#writing-messages) first; the steps below don't
repeat them.

## Add or change a message

1. Find the feature's namespace in `packages/i18n/messages/en/<namespace>.json` (apps and
   features each have one; `common` only for generic labels). Name the key by meaning,
   prefixed with the namespace: `orders_status_open`, not `orders_open_text`.
2. Add the same key with the same placeholders to `packages/i18n/messages/de/<namespace>.json`.
   German addresses the reader as "du" and runs about a third longer; check narrow layouts.
3. For a new namespace, add both files and register the path in
   `packages/i18n/project.inlang/settings.json`. The catalog tests fail on unregistered files.
4. Compile so types pick up the change: `pnpm --filter @luma/i18n build`. Running dev servers
   recompile when a message file changes.
5. Use the message from code:

   ```tsx
   import { m } from '@luma/i18n/messages';

   // In a module-level map, store the function and call it while rendering.
   const labels = { open: m.orders_status_open };

   // Plural messages format the number themselves: pass the number.
   <p>{m.orders_summary_needs_you({ count: issues })}</p>;
   ```

   Use `rich` from `@luma/i18n/rich` for links or emphasis inside a sentence. Feature
   wording that several components share belongs in the feature's `presentation.ts`.

6. Format numbers, amounts, dates, relative times and lists with `@luma/i18n/format`, passing
   the workspace time zone where the page shows workspace time. Never format dates inside a
   message.

Remove keys the change no longer uses from both languages.

## Text that comes from the server

Server catalogs (permissions, roles, app manifests, metrics, workflow vocabulary) stay English
on the server and are localized in the web by stable key; see
[text from the server](../../../docs/localization.md#text-from-the-server). When you change the
server's English text, change the English message to match and update the German one; the
owning package's test fails when they differ. Other server text, such as API error details and
diagnosis explanations, stays English.

## Add an interface language

1. Add the locale to `locales` in `packages/i18n/project.inlang/settings.json`.
2. Add its own name to `localeNames` and its formatting locale to `formattingLocales` in
   `packages/i18n/src/locales.ts`.
3. Add a complete set of message files under `packages/i18n/messages/<locale>`.
4. Add the language to the documentation source in `apps/web/src/features/help/source.ts` so
   product guides can be translated.
5. Check narrow layouts and long words in the new language.

## Check it

Run `pnpm --filter @luma/i18n test` for catalog completeness, placeholders and plural rules.
Review the changed screens in both languages and both themes. Finish with the
[verify-change](../verify-change/SKILL.md) skill.
