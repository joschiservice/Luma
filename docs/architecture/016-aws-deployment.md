# ADR-016: AWS deployment and the single-host Lite cell

Status: Accepted. Date: 2026-10-19.

## Context

[ADR-003](003-tenant-isolation-and-data-residency.md) places the launch cell in Australia, with
Sydney storage, a Sydney KMS key for Temporal payloads, Bedrock in Sydney and self-hosted
Temporal. Luma has no production cell yet, few tenants and a tight budget. The application
needs PostgreSQL 17, Valkey, Temporal with TLS and KMS payload encryption in production, the
API, the workflow worker, commerce sync, the TanStack Start server, the staff API, and the
Code Steps runtime on Linux. Infrastructure must be reviewable code, and synthesizing it must
not require cloud credentials.

## Options considered

| Option                                                                         | Assessment                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed multi-AZ AWS from the start (Fargate, load balancer, RDS, ElastiCache) | Meets ADR-003's production cell, but idle cost is dominated by managed services that serve almost no traffic yet.                                                                                                                         |
| One EC2 host in Sydney running Docker Compose                                  | Lowest predictable cost with the same images, IAM, KMS, S3 and Bedrock as a later managed cell. No redundancy; the operator owns OS updates and restores.                                                                                 |
| Lightsail                                                                      | Similar flat price, but no instance role, limited CloudFormation support and a separate network, which makes the later move harder.                                                                                                       |
| Azure or Google Cloud                                                          | No cost advantage for one small host. KMS and Bedrock remain on AWS, and Claude processing in Australia on those platforms is unconfirmed; each provider adds an ADR-003 review.                                                          |
| Vercel for the signed-in web app                                               | The app calls `/api` on its own origin under a `connect-src 'self'` policy, so Vercel would terminate and log tenant requests outside the cell or force a cross-origin API. It suits only the session-free global entry and public pages. |
| Hand-written CloudFormation, Terraform, LocalStack                             | CloudFormation templates are verbose; Terraform adds a second language and state. LocalStack now needs an account and a paid plan for the services involved, and local development already runs the real PostgreSQL, Valkey and Temporal. |

## Decision

Deploy on AWS in `ap-southeast-2`, described with AWS CDK in TypeScript in the `infra`
workspace. Synthesis and its cdk-nag AWS Solutions checks run offline in CI; deploying is
an explicit operator step.

- **Accounts:** AWS Organizations with separate staging and production accounts. A service
  control policy denies regional actions outside `ap-southeast-2` and `ap-southeast-4`, the
  regions Australian Bedrock profiles use.
- **Foundation, per stage:** the Temporal payload key, the server image repository, the
  Object Lock backup bucket, alerts, a cost budget, the GitHub deployment role, and IAM
  principals that sign KMS, Bedrock and SES requests and can do nothing else. Data-bearing resources are
  retained when a stack is deleted.
- **Lite cell, per stage:** one Graviton instance in a public subnet with an Elastic IP and no
  NAT gateway or load balancer. Docker Compose runs Caddy, the Luma processes, PostgreSQL,
  Valkey and Temporal. Caddy terminates TLS in the region and proxies `/api` as the identity
  guide requires. State lives on a separate EBS volume that the host attaches itself, with
  daily AWS Backup snapshots copied to a Melbourne vault and logical dumps in S3. The host
  image is pinned in CDK context, so only a reviewed change replaces the instance. A
  CloudWatch agent, log metric filters and an external readiness probe raise alarms.
- **Temporal:** the official server image on the cell's PostgreSQL. Its frontend presents a
  certificate from a private CA that clients trust through `TEMPORAL_TLS_SERVER_CA`, which
  satisfies the production TLS requirement without a public endpoint.
- **Credentials:** the instance metadata service is unreachable from containers, so the
  instance role, which reads every deployment secret, never reaches application code.
  The application signs AWS requests with the narrowly scoped principals' access keys, which
  the host creates and stores as SSM SecureStrings with the generated database passwords and
  auth secrets.
- **Staff access:** the staff console and staff API listen only on the private Docker
  network. Two Tailscale nodes give them tailnet HTTPS names; nothing about them is public.
  Google Workspace sign-in remains the authentication.
- **Delivery:** one server image runs every Node process and carries the host files of its
  commit. A manual GitHub workflow accepts only `main` or `v*` commits whose quality gates
  passed. Staging builds the image for arm64, pushes it with OIDC credentials and must pass a
  smoke journey; ECR replication copies it to production, which deploys the same digest only
  after staging succeeded. The host deploy command runs through a stage SSM document that
  accepts only an image tag and digest.

The production cell keeps the same image, settings and parameter layout and replaces the
host with managed services: a multi-AZ VPC, a load balancer with WAF, Fargate services, RDS
PostgreSQL Multi-AZ with point-in-time recovery, ElastiCache with a replica and Temporal
across zones. It will replace the access keys with task-role credentials, which needs
container credential support in the AWS request signer. It is designed but not built until a
customer needs its availability.

## Consequences

- One host is a single point of failure, and deploys restart containers briefly. AWS
  restarts or recovers the instance on failed status checks.
- A stack update that changes the AMI replaces the instance; the new host waits for the
  data volume and restores the last deployment, with a few minutes of downtime.
- Migrations only move forward. A deploy whose services fail health checks returns to the
  previous image, which works only because migrations follow expand and contract.
- Without a domain, hosts use sslip.io names derived from the Elastic IP, which depend on
  that service and Let's Encrypt's limits for its shared domain.
- The access keys are long-lived and must be rotated by the operator.

## Reversal cost

Moderate. The application runs unchanged in containers; moving to the production cell or
another provider means restoring the database dumps and recreating the regional resources
under a new ADR-003 review.

## Evidence

Monthly idle estimates from list prices in October 2026, to be confirmed in the AWS pricing
calculator: the Lite cell about US$40–70 depending on instance size; the managed design about
US$500–700, mostly NAT gateways, Multi-AZ RDS and the load balancer. Oracle's free tier was
halved in 2026 and capacity in Sydney is not guaranteed; Lightsail 8 GB lists at about US$44.
Temporal 1.32 configures frontend TLS through `TEMPORAL_TLS_FRONTEND_*` settings and its
schema through `temporal-sql-tool`; the Compose stack was exercised locally with these
images before adoption.
