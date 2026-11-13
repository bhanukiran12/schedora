# Schedora AWS deployment plan

Status: staging preparation is in progress. The `schedora-ecr` stack and private repository are deployed in `ap-south-1`, and image `staging-20261112-01` is pushed. The runtime boundary now grants read access to the exact `AppBeta` secret ARN; secret values have not been inspected. The ECS web service and LiveKit VM have not been deployed. Render and production DNS remain untouched.

## Target architecture

- **Schedora web/API:** the existing Docker image runs as one ECS Fargate task behind an internet-facing Application Load Balancer with HTTPS. Keep one task until background jobs and rate limiting are safe across multiple replicas.
- **LiveKit:** a separate EC2 VM runs the official LiveKit Docker Compose/Caddy bundle because WebRTC needs public UDP media ports and host networking.
- **Database:** keep Supabase Postgres and `DATABASE_URL` unchanged; no database migration is part of this plan.
- **Rollback:** keep Render and LiveKit Cloud available until both AWS staging services pass acceptance. Move DNS and production provider settings only after that.

## Prepared files

- `infra/aws/schedora-ecr.yaml` creates a private, scan-on-push ECR repository with immutable tags.
- `infra/aws/schedora-web.yaml` creates an ECS cluster, one Fargate service, HTTPS load balancer, health checks, CloudWatch logs, task security groups, and secret references.
- `infra/aws/livekit-staging.yaml` creates a staging EC2 host, encrypted disk, Elastic IP, WebRTC security group, and SSM-only administration.
- `.github/workflows/ci.yml` runs verification and PostgreSQL jobs, deploys Meet on successful `main` pushes, and offers a manual LiveKit staging deployment. The LiveKit job requires the generated cloud-init in an encrypted Actions secret.
- `docs/AWS_LIVEKIT_STAGING.md` contains LiveKit-specific setup and acceptance steps.

## Current AWS execution state (2026-11-12)

- Confirmed AWS identity: IAM user `schedora-v1` in account `255948905492`; root credentials were not used.
- Created IAM policy `SchedoraDeployPolicy` and attached it through the `SchedoraDeploy` group. Removed nine unrelated policies from that deployment group so it contains only the scoped Schedora policy; the group has one user. Existing policies attached directly to the IAM user were not changed.
- Created CloudFormation stack `schedora-ecr` and its private, immutable, scan-on-push ECR repository in `ap-south-1`.
- Built the current checkout as `schedora-web:staging-20261112-01` and pushed it to `255948905492.dkr.ecr.ap-south-1.amazonaws.com/schedora-web`; ECR reports the image as `ACTIVE`.
- AWS accepted `schedora-web.yaml` in `validate-template`. The default VPC and three public subnets across separate Availability Zones are available.
- Permanently updated `SchedoraDeployPolicy` with `acm:RequestCertificate`, restricted to `ap-south-1` and names under `staging.schedora.in`. Requested an ACM certificate for the staging hostname and its wildcard; it is pending DNS validation. ACM returned one CNAME record shared by both names; add it in GoDaddy before continuing.
- Permanently updated `SchedoraRuntimeBoundary` to allow `secretsmanager:GetSecretValue` for the exact `AppBeta` ARN in addition to the existing `schedora-*` pattern. AWS confirmed the update; secret contents were not read.
- GitHub Actions repository variables exist for the deploy role, AppBeta ARN, replacement Meet certificate ARN, VPC, and both public subnets. GitHub requires email identity verification before the certificate variable update can be saved. The local workflow is not pushed yet.
- Workflow validation passed locally: YAML parsed, `git diff --check` found no whitespace errors (only pre-existing CRLF notices), the backend check passed across 204 files, and 397 backend tests passed with 7 PostgreSQL-only tests skipped. GitHub Actions has not run for these local changes.
- To stay under AWS's 6,144-character customer-managed policy limit, removed `cloudformation:CancelUpdateStack` from the final policy. The deployment identity can no longer manually cancel a CloudFormation update; this does not block normal stack create/update operations.
- No ECS service, load balancer, LiveKit VM, or production DNS record has been created. The generated LiveKit cloud-init stays ignored locally; the Actions encrypted secret has not been created.

The app template expects two public subnets in different Availability Zones, a region-matched ACM certificate covering the staging app hostname and product subdomains, an existing ECR image, and an existing Secrets Manager JSON secret. The EC2 template expects one public subnet and the cloud-init output from LiveKit's official generator. DNS records are intentionally not created by either stack.

## Secrets Manager payload

Create one JSON secret for the app and keep the existing Supabase connection string as its `DATABASE_URL` value. Add each key below even if a provider is initially disabled; optional values can be empty strings. Never put production secret values in CloudFormation parameters or Git.

`DATABASE_URL`, `APP_ENCRYPTION_KEY`, `ALLOWED_ORIGINS`, `COOKIE_DOMAIN`, `EMAIL_HTTP_URL`, `EMAIL_HTTP_TOKEN`, `EMAIL_FROM`, `ASSIST_ADDRESS`, `OPERATOR_NAME`, `OPERATOR_CONTACT`, `OPERATOR_JURISDICTION`, `ALERT_WEBHOOK_URL`, `ALERT_EMAIL`, `ALERT_EMAIL_PROVIDER`, `BILLING_WEBHOOK_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `INBOUND_EMAIL_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_URL`.

For the first AWS staging release, the task definition explicitly keeps billing in open/evaluation mode and video disabled. Provider credentials do not turn those features on by themselves. Configure the video environment only after the LiveKit staging test and webhook/security review.

## Deployment order

1. Create the app secret in AWS Secrets Manager using existing provider values from the secure Render dashboard; do not print or paste secret values into this repository. Preserve `APP_ENCRYPTION_KEY` exactly so encrypted integrations remain readable.
2. Request/validate an ACM certificate in `ap-south-1` for the staging hostname and product subdomains. The app template can use the existing public subnets in different Availability Zones. Confirm ECS Fargate and load balancer charges before launching.
3. Deploy the ECS stack with evaluation billing and video disabled. Test `/api/health`, authentication, forms, scheduling, workflows, emails, OAuth callbacks, Supabase database reads/writes, backup/restore, and rollback. The service uses the existing Supabase DB; verify SSL and allowlisted connectivity from AWS.
4. Run LiveKit's official VM configuration generator for staging signaling and TURN hostnames. Keep generated files outside Git and image build context; use staging-only API keys.
5. Deploy the LiveKit EC2 staging stack. Point only staging DNS records to its Elastic IP. Verify TLS, UDP/TCP connectivity, two-browser media, screen share, participant removal, webhook delivery, reconciliation, reconnect/revocation behavior, and cost/traffic metrics.
6. Keep Render and LiveKit Cloud serving production while staging is tested. After acceptance, prepare a reviewed production change set, change app DNS and video settings in a controlled window, and retain a rollback path to the old hosts.

## Remaining gates before an actual deployment

- The app's Secrets Manager secret has not been verified; the deployment identity cannot list secrets. Its ARN and contents must be supplied/created securely, preserving the current encryption key and Supabase URL.
- The Meet ACM certificate is pending DNS validation. The user added the CNAME; keep it and wait until ACM reports Issued. The replacement ARN is still waiting for GitHub email verification.
- The app's `AppBeta` secret values have not been inspected; confirm they contain the required keys and real values before deploying.
- The LiveKit GitHub Actions secret containing generated cloud-init is not configured yet.
- The staging ACM certificate is pending DNS validation. Add the CNAME below in GoDaddy, then wait until ACM reports Issued:
  - Name: `_659d1091f58718204d22fb8eb6389378.staging.schedora.in.`
  - Value: `_e026ac532e4645b24f1a7c73bfd8b184.wzccmgtwzk.acm-validations.aws.`
- LiveKit's official VM configuration is generated locally; keep it out of Git and store it only as an encrypted Actions secret if using the workflow.
- Confirm current budget/credits and monthly spend for Fargate, ALB, EC2, public IPv4, logs, and media egress. A running service can spend beyond promotional credits.
- Run the requested application, browser, video, backup/restore, security, and cost acceptance checks before production DNS cutover.

## Local checks performed for this preparation

- CloudFormation accepted all three templates with `validate-template`.
- `npm run check` passed; Docker built the current app image; a local container answered `/api/health` with status `ok`.
- `npm test`: 397 passed, 0 failed, 7 PostgreSQL-only cases skipped because a PostgreSQL test database was not configured.
- The full browser journey run completed 744 responsive layout measurements across four widths and light/dark themes, but multiple journeys failed. Failures included Forms creation/publish, booking email wording, some Meet readiness/video flows, billing, and onboarding. Treat browser acceptance as blocked until those failures are triaged; do not call this production-ready.
- The local container smoke test used temporary SQLite because it had no Supabase secret. It does not verify the live Supabase connection or production credentials.

## Official references

- [LiveKit VM deployment](https://docs.livekit.io/transport/self-hosting/vm/)
- [LiveKit network and host-networking guidance](https://docs.livekit.io/transport/self-hosting/deployment/)
- [AWS ECS Fargate networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html)
- [AWS Secrets Manager injection for ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)
