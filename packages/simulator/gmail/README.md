# @luma/simulator-gmail

Simulates a shared Gmail mailbox behind the Gmail API v1 calls Luma's Gmail app makes, and Google's OAuth token and revoke endpoints. Both arrive through the same simulator instance, because the simulation transport forwards every request URL of a connection.

The package owns the protocol: Gmail's message, thread, part-tree, attachment, label and error JSON; search with the operators Luma's query builder uses (`from:`, `to:`, `cc:`, `deliveredto:`, `label:`, `in:`, `after:`, `before:`, `rfc822msgid:`, `has:attachment`, `OR`, `-` and groups); bearer authentication (401 when rejected) and Gmail's per-user quota units (429). The host table is `sim_gmail_records`. Exports point to compiled `dist` output.

## Behavior to know

- **Sending** parses the raw RFC 5322 message, keeps a client Message-ID and joins `threadId` only when In-Reply-To or References name a message of that thread and the base subjects match; otherwise the message starts a new thread, as in Gmail. Sending the same message twice stores it twice. Luma must prevent duplicates itself.
- **Search** lags behind new messages by the run's index lag, like Gmail's index; direct reads see them at once. `after:` with epoch seconds is exclusive. Malformed queries answer 400 rather than guessing.
- **Attachment IDs** differ on every message read, as in Gmail; any of them fetches the attachment.
- **OAuth** accepts any non-empty code or refresh token and issues an unsigned ID token with the mailbox address. Rejected credentials answer `invalid_grant`.
- **Push** is not simulated. `watch` and `stop` are accepted, but no Pub/Sub notification is delivered, so Luma reads the mailbox by polling. `users.history` is not served.
- **Commands** seed the mailbox and deliver mail from external senders, optionally as a reply. Mail from the mailbox's own address is stored as sent by another client. Delivering an existing Message-ID returns the stored message.

## Validation

`pnpm test:simulator` runs `tooling/simulator/gmail-contract.test.mjs`, which drives the real Gmail adapter against this package.

## Further reading

- [Simulator](../../../docs/simulator.md#operations-mailbox)
