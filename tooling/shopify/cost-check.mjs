import { checkReadCosts, costProblems, maxQueryCost } from './read-costs.mjs';

const shop = process.env.SHOPIFY_COST_CHECK_SHOP;
const accessToken = process.env.SHOPIFY_COST_CHECK_TOKEN;
if (!shop?.endsWith('.myshopify.com') || !accessToken)
  throw new Error(
    'Set SHOPIFY_COST_CHECK_SHOP to a development store domain such as luma-dev.myshopify.com and SHOPIFY_COST_CHECK_TOKEN to an Admin API access token with read scopes',
  );

const report = await checkReadCosts({ shop, accessToken });
console.table(
  report.queries.map((query) => ({
    capability: query.capability,
    query: query.operation,
    shopify: query.shopify ?? 'not reported',
    simulator: query.simulator,
    within: query.shopify === null ? '?' : query.shopify <= maxQueryCost,
  })),
);
for (const failure of report.failures)
  console.error(`${failure.capability} failed:`, failure.error);
const problems = costProblems(report);
for (const problem of problems)
  console.error(
    `${problem.capability} ${problem.operation}: Shopify requests ${problem.shopify}, the simulator estimates ${problem.simulator}`,
  );
if (problems.length || report.failures.length) process.exitCode = 1;
