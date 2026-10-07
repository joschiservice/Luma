# @luma/assistant

Answers workspace questions (Ask Luma) with a bounded model loop over read-only tools.

Owns the tool registry, the model and tool loop, its budgets and citation resolution. Asking needs `assistant.use`. Each tool declares the read permission it needs, and the model is offered only the tools the person's freshly checked context allows. Tools call owner read services with that context; the assistant never writes and has no tables. Model routing and data policy enforcement belong to the platform gateway.

## Public entry points

- `@luma/assistant`
- `@luma/assistant/composition`
- `@luma/assistant/http`

## Further reading

- [Ask Luma assistant](../../docs/assistant.md)
- [Model gateway](../../docs/model-gateway.md#assistant-profile)
