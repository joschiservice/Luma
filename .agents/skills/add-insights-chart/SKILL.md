---
name: add-insights-chart
description: Add a chart to Luma's operational Insights whose points open the exact records they count, with one shared counting rule, contract, read model, web definition and reconciliation test. Use when adding or changing an Insights chart or its counting rule.
---

# Adding an Insights chart

Every Insights point opens the records it counts, and a chart and its records are computed
by the same rule, so their totals agree. Read
[operational insights](../../../docs/operational-insights.md) and the
[operational metrics](../../../docs/operational-metrics.md) limits first.

1. **Write the counting rule once**, as owner SQL or an owner function in the domain that owns
   the records, and use it for both the chart and its record list. Bound the read; reads have
   a 4-second statement timeout.
2. **Add it to the contract** in `packages/api-contract/src/insights.ts` and to the read model
   in `@luma/read-models`.
3. **Add the web definition** in `apps/web/src/features/insights`, with wording people can
   check against the records, in both languages (see the [localize-ui](../localize-ui/SKILL.md)
   skill). State what the chart can't claim in its `limit`.
4. **Keep it live.** Every table the chart reads needs the `metric_change` trigger with its
   topic, and that topic must be in `chartTopics` in `apps/web/src/features/insights/live.ts`;
   see [topics](../../../docs/operational-metrics.md#topics).
5. **Reconcile.** Extend the point-to-records reconciliation check in
   `apps/api/e2e/insights.e2e.mjs`. For a heavy read, measure with
   `LUMA_INSIGHTS_BENCHMARK=<order count> pnpm test:performance insights`.
6. **Document the rule** in the chart table of the Insights guide.

Finish with the [verify-change](../verify-change/SKILL.md) skill.
