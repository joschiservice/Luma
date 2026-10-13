// Local test overrides exercise the same flags that PostHog evaluates in production.
process.env.FEATURE_FLAG_OVERRIDES =
  'workflow-improvements=true,workflow-improvement-discovery=true';
await import('./authoring-server.mjs');
