// k6 load test for the tenant request pool: concurrent members reading Needs you and the order
// list over HTTP. apps/api/e2e/request-pool.performance.e2e.mjs seeds the workspace, starts the
// API and runs this script with BASE_URL (the workspace API path), COOKIE and SUMMARY set.
/* global __ENV */
import { check } from 'k6';
import http from 'k6/http';

const base = __ENV.BASE_URL;
const params = { headers: { cookie: __ENV.COOKIE } };

export const options = {
  scenarios: {
    members: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 20 },
        { duration: '20s', target: 20 },
        { duration: '5s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  // The script reports these; the scenario enforces the same budgets in its report.
  thresholds: {
    http_req_failed: ['rate==0'],
    'http_req_duration{read:decisions}': ['p(95)<2000'],
    'http_req_duration{read:orders}': ['p(95)<2000'],
  },
  summaryTrendStats: ['avg', 'p(95)', 'max'],
};

/** Reads Needs you and the order list at once, as a member opening the workspace does. */
export default function members() {
  const responses = http.batch([
    [
      'GET',
      `${base}/decisions`,
      null,
      { ...params, tags: { read: 'decisions' } },
    ],
    ['GET', `${base}/orders`, null, { ...params, tags: { read: 'orders' } }],
  ]);
  for (const response of responses)
    check(response, { 'status is 200': (r) => r.status === 200 });
}

/** Writes the end-of-test summary as JSON for the scenario's performance report. */
export function handleSummary(data) {
  return { [__ENV.SUMMARY]: JSON.stringify(data) };
}
