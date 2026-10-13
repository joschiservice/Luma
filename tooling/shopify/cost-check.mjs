import { checkReadCosts, costProblems, maxQueryCost } from './read-costs.mjs';

const shop = process.env.SHOPIFY_COST_CHECK_SHOP;
const accessToken = process.env.SHOPIFY_COST_CHECK_TOKEN;
if (!shop?.endsWith('.myshopify.com') || !accessToken)
  throw new Error(
    'Set SHOPIFY_COST_CHECK_SHOP to a development store domain such as luma-dev.myshopify.com and SHOPIFY_COST_CHECK_TOKEN to an Admin API access token with read scopes',
  );

const customerApproval = process.env.SHOPIFY_COST_CHECK_CUSTOMER_ACCESS;
const customerChoices = ['basic', 'contact', 'address', 'contact,address'];
if (customerApproval && !customerChoices.includes(customerApproval))
  throw new Error(
    'SHOPIFY_COST_CHECK_CUSTOMER_ACCESS must be basic, contact, address or contact,address and reflect the app’s approved protected customer data access.',
  );
const customerAccess = customerApproval
  ? {
      contact: customerApproval.split(',').includes('contact'),
      address: customerApproval.split(',').includes('address'),
    }
  : undefined;
const report = await checkReadCosts({
  shop,
  accessToken,
  ...(customerAccess ? { customerAccess } : {}),
});
console.table(
  report.queries.map((query) => ({
    capability: query.capability,
    query: query.operation,
    shopify: query.shopify ?? 'not reported',
    simulator: query.simulator,
    within: query.shopify === null ? '?' : query.shopify <= maxQueryCost,
  })),
);
for (const skipped of report.skipped)
  console.info(`${skipped.capability} skipped: ${skipped.reason}`);
for (const failure of report.failures)
  console.error(`${failure.capability} failed:`, failure.error);
const problems = costProblems(report);
for (const problem of problems)
  console.error(
    `${problem.capability} ${problem.operation}: Shopify requests ${problem.shopify}, the simulator estimates ${problem.simulator}`,
  );
if (problems.length || report.failures.length) process.exitCode = 1;
