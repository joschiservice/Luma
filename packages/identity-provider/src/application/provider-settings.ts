import type { VerifiedExternalIdentity } from '../domain/external-identity.js';

/** Authorizes an explicit issuer/subject binding without deriving authority from email alone. */
export type ExternalIdentityValidator = (
  identity: VerifiedExternalIdentity,
) => boolean | Promise<boolean>;

/** Server-owned OIDC configuration; never populate discovery or issuer from browser input. */
export interface OidcAuthSettings {
  providerId: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  expectedIssuer: string;
  hostedDomain?: string;
  validateIdentity: ExternalIdentityValidator;
}

/** Google Workspace credentials and a single exact hosted domain authorized by the operator. */
export interface GoogleWorkspaceAuthSettings {
  clientId: string;
  clientSecret: string;
  hostedDomain: string;
  validateIdentity: ExternalIdentityValidator;
}
