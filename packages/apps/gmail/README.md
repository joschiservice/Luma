# @luma/app-gmail

First-party Gmail workspace app. Owns Google authorization, mailbox bindings, push notifications, verification, the message capabilities and the deferred setup UI.

The public `createApp` factory contributes to the app host; `createGmailProvider` composes the connector for fixtures and simulators. Low-level transport, OAuth requests, query building and MIME handling stay in `@luma/connector-gmail`. App tables are created by the migrations in `migrations/`.

See [Workspace apps](../../../docs/apps.md) for the installation lifecycle and [Gmail](../../../docs/gmail.md) for provider behavior, setup and limits.
