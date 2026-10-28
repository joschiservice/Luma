# Localization

Luma's interface is available in English and German. `@luma/i18n` owns the message catalogs,
the language runtime and the formatting helpers; Paraglide JS compiles the catalogs into typed
message functions, so a missing message or a wrong placeholder is a type error. English is the
source language. Translated product guides are covered in
[documentation and contextual help](contextual-help.md).

## Choosing the language

The language is chosen per browser, like the theme: the `luma_locale` cookie, then the
browser's preferred languages, then English. Changing it (Settings, the account menu, the
command menu, the top corner of sign-in and other pages outside a workspace, or the
documentation header) stores the cookie and reloads the page, so server-rendered text,
document language and formatting switch together.

The web server entry runs Paraglide's middleware around every request, which makes the
request's language available to rendering and server handlers through async local storage.
Code that runs outside a request, such as unit tests and scripts, gets English.

The account also stores the language, for email sent outside a request: the first signed-in page
after a change sends it, and sign-in records the browser's language. Don't override Paraglide's
`setLocale` to send it: with an override, keyboard reordering in the workflow editor stops
working. Email is written in
that language; see [language and content](workspace-settings.md#language-and-content). Other
text produced by the API stays in English; see [text from the server](#text-from-the-server).

## Writing messages

Messages are ICU MessageFormat strings in `packages/i18n/messages/<locale>/<namespace>.json`,
one namespace per feature area. Keys start with their namespace and name the meaning rather
than the English wording, so a copy edit doesn't need a new key. `common` holds a small set of
generic labels and sentences; prefer a feature key when the wording depends on context. Every
language must contain every key with the same placeholders; the package tests enforce this
and check that each file is registered in the inlang project settings.

Rules beyond what the compiler checks:

- **Never call a message function at module scope.** Module scope runs once per server
  process, so the text would be frozen in whichever language loaded first. Store the function
  (`label: m.orders_status_open`) and call it while rendering. Exported maps that other
  modules read as strings use getters. ESLint rejects message and formatting calls at
  module scope in application and package code.
- **Plurals:** write `{count, plural, one {{count, number} order} other {{count, number}
orders}}`. Paraglide inserts `#` without number formatting and compares exact matches such
  as `=0` against strings, so they never match a number; the tests reject both. Write a
  separate message for an empty state.
- **Dates and times** are not formatted inside messages. Format them with the helpers below
  and pass the result as a placeholder.
- **German addresses the reader as "du"**, lowercase mid-sentence (du, dich, dir, dein), to match
  the Auren website and brand guide. Don't use "Sie" for the reader, in the interface or in the
  guides. The queue is „Wartet auf dich“.
- **Whole sentences only.** Don't join translated fragments or add plural endings in code;
  word order differs between languages. For links or emphasis inside a sentence, render the
  message with `rich` so translators keep control of where the element goes.

## Formatting

Display numbers, amounts, dates, relative times and lists with the helpers in
`@luma/i18n/format`. They follow the interface language and cache their `Intl` formatters
per language. English uses day-month-year dates and a 24-hour clock, matching the house
style ("8 October 2026, 14:05"), with US spelling in the messages. Pass the workspace time
zone where a page shows workspace time. Machine formats, such as ISO dates built from
`Intl` parts, keep a fixed locale.

## Text from the server

The server stays the English source for the API, OpenAPI and the permission reference.
Catalogs it serves under stable keys are localized in the web by key: permission groups,
permissions and built-in roles (`permissions`), app manifest descriptions and app
permissions (`catalog`, `permissions`), operational metric definitions (`metrics`), workflow
triggers, step types and subjects (`vocabulary`), and issue kinds by exception class
(`issues`). Keys derive from the server ID with `.`, `:` and `-` replaced by `_`. The lookup
helpers return the server's text for keys the client doesn't know, such as a newly added
permission or a custom role.

The English message must equal the server text. Tests in each owning package (identity, the
metric owners, exceptions, workflows, procurement, resolution and each app) read the English
catalog and fail when they differ, so change both together and write the German translation
in the same change.

Other visible text still arrives in English: provider data, issue diagnosis and decision
explanations, workflow templates and step summaries, reads, actions and checks that apps
describe for workflow authors, reasons an entry can't run, metric coverage notes, model
answers and API error details. Error handling maps generic API error codes to
translated messages and keeps the server's detail for validation and conflict errors, which
are specific to the request.

## Adding text or a language

The [localize-ui](../.agents/skills/localize-ui/SKILL.md) skill covers the steps for adding
messages, namespaces and interface languages. Check narrow layouts: German runs about a third
longer than English.

## Build

There are two compiled runtimes. The package build writes the shared one, with one module per
locale, which tests, Storybook and dev servers import: an unbundled dev server requests every
module a page imports, and one module per message made each page load request thousands of
files. Production builds of the web app compile a separate runtime with one module per message,
so each route chunk carries only its own messages, and the Vite plugin redirects every import of
the shared runtime to it. Keeping them apart means a build never rewrites the runtime a running
dev server reads, and the bundle contains exactly one runtime, which matters because the
request's language lives in that runtime's state.

Type declarations use one module per message even for the shared runtime. TypeScript's
declaration emitter repeatedly searches the exports of large locale modules; keeping the
declarations in small modules avoids that cost without increasing dev-server requests.
Both outputs are compiled from the same loaded project before they are published together.

Compiles take turns through a lock and swap the result into place, so concurrent Turbo tasks
and dev servers never read a half-written runtime. Dev servers don't compile at startup unless
the runtime is missing; they recompile when a message file changes. Don't switch to
Paraglide's own Vite plugin: it rewrites the runtime whenever a server starts, which breaks
other servers and builds reading it at the same time. The ICU storage plugin loads from the
installed package rather than a CDN, so compiling needs no network access; keep it that way
when upgrading.
