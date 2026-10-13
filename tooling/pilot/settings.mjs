/** Builds identity-service settings from the pilot's environment. */
export const identitySettings = (env) => ({
  databaseUrl: env.IDENTITY_DATABASE_URL,
  secret: env.BETTER_AUTH_SECRET,
  cookiePrefix: env.BETTER_AUTH_COOKIE_PREFIX,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.BETTER_AUTH_URL],
});
