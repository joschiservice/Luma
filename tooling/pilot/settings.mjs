import { readIdentityConfig } from '@luma/config';

/** Builds validated identity settings for the pilot cell. */
export const identitySettings = (env) => readIdentityConfig(env);
