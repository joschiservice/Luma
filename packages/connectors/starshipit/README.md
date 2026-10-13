# @luma/connector-starshipit

Fixed-host Starshipit protocol transport and validated responses. Both credentials are
resolved before each request. Only safe reads may be retried; dispatched update failures
preserve uncertainty. Installation and normalization belong to the workspace app.

See [Starshipit](../../../docs/starshipit.md) for supported reads and updates.
