/** A provider identity established by verified OIDC claims, separate from local authority. */
export interface VerifiedExternalIdentity {
  issuer: string;
  subject: string;
  email: string;
  name: string;
  hostedDomain?: string;
}

/** Checks required profile claims after the OIDC library verifies the ID token. */
export function readExternalIdentity(
  claims: Readonly<Record<string, unknown>>,
  expectedIssuer: string,
  hostedDomain?: string,
): VerifiedExternalIdentity | null {
  if (
    claims.iss !== expectedIssuer ||
    typeof claims.sub !== 'string' ||
    !claims.sub.trim() ||
    typeof claims.email !== 'string' ||
    !/^[^\s@]+@[^\s@]+$/.test(claims.email) ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    typeof claims.iat !== 'number' ||
    !Number.isFinite(claims.iat) ||
    claims.iat > Math.floor(Date.now() / 1000) + 60 ||
    claims.exp <= claims.iat ||
    claims.email_verified !== true ||
    (hostedDomain !== undefined && claims.hd !== hostedDomain)
  ) {
    return null;
  }

  return {
    issuer: expectedIssuer,
    subject: claims.sub,
    email: claims.email.toLowerCase(),
    name:
      typeof claims.name === 'string' && claims.name.trim()
        ? claims.name
        : claims.email,
    ...(typeof claims.hd === 'string' ? { hostedDomain: claims.hd } : {}),
  };
}
