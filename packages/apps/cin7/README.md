# @luma/app-cin7

First-party Cin7 Core workspace app. Owns connection setup, verification, the read adapters and the deferred setup UI.

The public `createApp` factory contributes to the app host; `createCin7Provider` composes the connector for fixtures and simulators. Low-level transport, request pacing and response schemas stay in `@luma/connector-cin7`.

See [Workspace apps](../../../docs/apps.md) for the installation lifecycle and [Cin7](../../../docs/cin7.md) for provider behavior and limits.
