# @luma/infra

AWS CDK stacks for the AU cell and the files the Lite cell host runs. Read the
[deployment guide](../docs/deployment.md) and [ADR-016](../docs/architecture/016-aws-deployment.md)
before changing either.

- Never deploy, bootstrap or diff against an AWS account from an agent session; synthesis
  and `pnpm --filter @luma/infra test` are offline and enough to verify a change.
- Keep account IDs, domains and addresses in CDK context, not in source. Secrets belong in
  SSM SecureStrings created by the host or the operator, never in templates or outputs.
- Every stack stays in the regions ADR-003 approves. Data-bearing resources keep a retain
  or snapshot removal policy.
- Prefer a narrower permission to a cdk-nag acknowledgment; an acknowledgment states why
  the finding is acceptable.
- `lite/` is uploaded to the host as is. Its scripts run as root with `set -euo pipefail`;
  keep them idempotent, keep secrets out of process arguments where a tool allows it, and
  check them with shellcheck.
- Containers must not reach the instance metadata service. Do not raise the hop limit or
  give application containers the host's AWS credentials.
