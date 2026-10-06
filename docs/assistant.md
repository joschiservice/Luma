# Ask Luma assistant

Ask Luma answers workspace questions through a bounded model loop over read-only tools. It runs inside the API with the asking member's `TenantContext`. It doesn't call the Luma HTTP API or an MCP server, and the model never holds a credential. Users find it in the top bar, with ⌘ J and in the command menu; see the [user guide](../apps/web/content/docs/ask-luma.mdx).

## Request path

`POST /v1/organizations/:organizationId/assistant/answers` (`packages/assistant/src/api/assistant.ts`) calls `ask` in `application/assistant.ts`:

1. Refreshes the context and requires an owner, admin or member whose actor is unchanged.
2. Returns 503 with the availability reason, without calling a model, when the `assistant` route isn't an EU zero-retention Bedrock route (`assistantAvailability` in `packages/application-runtime/src/composition/authoring.ts`).
3. Sends the system prompt, the client's earlier turns and the question with `profile: 'assistant'` and `dataPolicy: { classification: 'sensitive', region: 'EU', zeroDataRetention: true }`.
4. For each tool batch, refreshes the context again and runs the calls through the tool registry. A removed member or changed actor ends the answer with the identity error.
5. Resolves citation markers in the final text and returns the answer, the cited records, the reads made and usage.

Conversations aren't stored. The client sends up to 20 earlier turns. The prompt tells the model to read again rather than rely on them, and citations only resolve to records read for the current question.

## Tools

`application/tools.ts` defines the registry; the tools live in `infrastructure/tools`. A tool has a stable name, a model-facing description, a JSON Schema, a parser, a person-facing summary of a call, and a handler that receives the freshly checked context. Filter values are typed against the read ports, and `composition/assistant.test.ts` checks them against the API contract. Handlers call owner read services (`OrderWorkspace`, `CaseService`, `InventoryWorkspace`, `FulfillmentWorkspace`, `ReturnWorkspace`), never SQL, so scoping, RLS and metric definitions match the pages.

| Tool                 | Reads                                     | Cites                             |
| -------------------- | ----------------------------------------- | --------------------------------- |
| `search_orders`      | `OrderWorkspace.list` with `count: exact` | orders                            |
| `get_order`          | `OrderWorkspace.get`                      | the order, its issues and returns |
| `search_issues`      | `CaseService.list`                        | issues                            |
| `get_issue`          | `CaseService.get` with its diagnosis      | the issue                         |
| `search_stock`       | `InventoryWorkspace.list`                 | stock positions                   |
| `search_fulfillment` | `FulfillmentWorkspace.list`               | fulfillment orders and shipments  |
| `search_returns`     | `ReturnWorkspace.list`                    | returns and refunds               |

To add a tool, write it with `defineTool` next to the others, register it in `createWorkspaceAssistant` (`src/composition.ts`), and add its record kind to `assistantRecordKindSchema` and the web `RecordLink` if it cites a new kind. Keep the projection small: only fields that answer questions, with provider text clipped.

Arguments are validated by the registry, not the gateway: the gateway tool parser only requires a JSON object. Invalid arguments and stale cursors become tool results with field problems, so the model can correct them within the read budget. Undeclared tools are still rejected by the gateway (`invalid_output`), which fails the answer before anything runs.

## Citations and evidence

Every record in a tool result carries a `cite` marker, `[[kind:id]]`. The model copies markers into its answer. `resolveCitations` (`domain/answer.ts`) keeps a marker only when that record was in a tool result shown to the model for this question, and returns the record's source labels, `observedAt` and `sourceUpdatedAt`. For issues, `observedAt` is the last activity. The web panel renders markers as numbered links and lists the sources under the answer.

## Limits

| Budget                     | Default           | On reaching it                                         |
| -------------------------- | ----------------- | ------------------------------------------------------ |
| Model calls per question   | 6                 | `outcome: incomplete` with a fixed message             |
| Tool calls per question    | 12                | Further calls return `lookup_limit` and are skipped    |
| Output tokens per call     | 2048              | Bedrock `max_tokens` fails the call (`invalid_output`) |
| Output tokens per question | 8192              | `outcome: incomplete`                                  |
| Deadline                   | 60 s              | 503, combined with client disconnects                  |
| Tool result size           | 12,000 characters | Items dropped from the end with `omitted`              |

Model failures map to fixed 503 reasons. No retries or fallback happen beyond gateway behavior; asking again is safe because nothing is written.

## Untrusted data and telemetry

Tool results include provider text, such as titles and return reasons. The system prompt marks tool results as data, not instructions. Prompt injection can at most change the wording of an answer: tools are read-only, scoped to the asking member, and citations only resolve to records actually read.

Questions, answers and tool data stay out of logs, spans and Langfuse. `agent.run` wraps a question, `tool.execute` each read, and `model.generate` records the route, token counts and latency.

## Availability and deployment

Route the `assistant` profile like authoring; see [Model gateway](model-gateway.md#assistant-profile). Synthetic local data doesn't need the [processing-path review](architecture/003-model-processing-path-review.md); tenant data does.

## Tests

- `packages/application-runtime/src/composition/assistant.test.ts`: scripted Bedrock responses through the real gateway, covering citations, unavailability, removed members, actor changes, invalid arguments, undeclared tools, read and call limits, cancellation, deadlines, result bounds and history.
- `packages/assistant/src/domain/answer.test.ts`: marker resolution and result bounding.
- `packages/application-runtime/src/composition/authoring.test.ts`: route availability.
- `apps/web/src/features/assistant/presentation.test.ts`: answer parsing, history and suggestions; `Assistant/Panel` stories cover the panel states.
