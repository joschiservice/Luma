import { Stack, Token, Validations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/** Records reviewed cdk-nag findings on a construct and its children. */
export function acknowledge(
  scope: IConstruct,
  findings: readonly { readonly id: string; readonly reason: string }[],
) {
  for (const finding of findings) Validations.of(scope).acknowledge(finding);
}

/**
 * Acknowledges reviewed wildcard grants in an IAM policy. cdk-nag reports each wildcard action
 * or resource as its own finding, such as `Resource::*`, so each must be named.
 */
export function acknowledgeWildcards(
  scope: IConstruct,
  reason: string,
  findings: readonly string[],
) {
  acknowledge(
    scope,
    findings.map((finding) => ({
      id: `AwsSolutions::AwsSolutions-IAM5[${finding}]`,
      reason,
    })),
  );
}

/** The account as cdk-nag writes it in finding IDs of environment-agnostic stacks. */
export function nagAccount(scope: IConstruct) {
  const { account } = Stack.of(scope);

  return Token.isUnresolved(account) ? '<AWS::AccountId>' : account;
}
