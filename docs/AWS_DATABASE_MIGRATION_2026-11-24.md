# Shared database migration to Amazon RDS

Status: Single-AZ selected and authorized by the owner on 24 November (option 2). RDS instance `schedora-shared` is available after the approved deployment-permission repair. No live data transfer, writer pause or application cutover has occurred. The owner approved the runtime credential-access change; the boundary update and exact role policy have been applied. The AWS connector needs reauthentication; operations use the existing `schedora-v1` CLI identity in account `255948905492`, `ap-south-1`. No credentials are recorded here.

## Verified starting point

- Source: one shared Supabase PostgreSQL database, schema v33, 105 tables. On 24 November the read-only inspection found two paused classic workflows, no queued email, no undispatched events and no pending upgrades. Never run application initialization against the source as a migration probe.
- AWS staging: ECS cluster/service `schedora/schedora-web`, task 21. Flow v1 was implemented and deployed on 23 November, with activation held. It is not a new implementation to rebuild from scratch.
- AWS has no RDS instances in Mumbai. The application VPC is `vpc-0342a9b2c3a6e0bcf`; its task security group is `sg-0bad4139df4a27d87`. Existing subnets `subnet-0707f850b6ffb69b5` and `subnet-0db05ae61b03a76b0` are in two availability zones.
- RDS currently offers PostgreSQL 17.11 with `db.t4g.micro`, gp3, encryption and optional Multi-AZ in this region. Match the source major version during the migration; do not combine this move with a major-version upgrade.

## Concrete provisioning package

`infra/aws/schedora-database.yaml` passed AWS CloudFormation template validation. It creates a private PostgreSQL instance with 20 GB gp3 storage, seven-day backups, deletion protection, retained snapshots, a customer-managed encryption key, encrypted database logs, enforced TLS, a managed owner password and a separate generated application credential. Database ingress accepts only the existing application's security group. It does not expose PostgreSQL to the internet.

The backend now selects the official bundled AWS Mumbai CA by the actual database hostname. Explicit `DATABASE_CA_CERT` remains supported; Supabase's trust bundle remains supported during migration and rollback. The public RDS bundle is from `https://truststore.pki.rds.amazonaws.com/ap-south-1/ap-south-1-bundle.pem`.

### Recurring cost requiring an owner choice

Source: AWS's public Mumbai RDS price list, published 20 November 2026:
`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-south-1/index.json`.

| Deployment | Instance USD/hour | gp3 USD/GB-month | 730 hours + 20 GB base/month |
| --- | ---: | ---: | ---: |
| Multi-AZ automatic failover | 0.042 | 0.262 | USD 35.90 |
| Single-AZ testing option | 0.021 | 0.131 | USD 17.95 |

These are base estimates, not a spending cap or total bill. Taxes, KMS, Secrets Manager, monitoring, transfer, excess backups and burst CPU charges may add cost. Credits or Free Tier eligibility are not assumed. The selected Single-AZ instance is now provisioning, with retained KMS/log/credential resources already created. Multi-AZ remains the template default.

## Cutover procedure

1. Obtain the monthly-cost choice. Provision the reviewed template in the app's VPC. Use the returned resource identifiers, not assumed ARNs. Verify the actual instance is available, private, encrypted, backed up and TLS-required.
2. Build the updated application with the RDS trust bundle. Preserve `APP_ENCRYPTION_KEY` exactly: existing integrations and encrypted data depend on it. Preserve email, video, EFS uploads, shared-cookie settings and the Flow activation hold.
3. Prepare a migration task inside the VPC. Its execution identity receives only the precise source and target secret references needed. Inject credentials at runtime through ECS secrets; never print them or embed them in a task command. The copy must run from inside the private network. Do not open the database publicly to make a laptop or Render connect.
4. Inventory **every** source reader/writer and frontend API route. The legacy Render service still has old code and uses the shared database; it cannot reach this private RDS database. Before retiring it, move or verify its production API traffic on compatible AWS application tasks. Do not leave two databases receiving writes. Production frontend routing is a required dependency, not something that can be assumed from staging health.
5. Announce maintenance, pause all writers, and compare two read-only inspections at least three minutes apart. Take a fresh full `schedora` schema/data dump with verified TLS; restore it to a disposable database and verify it. Keep the protected source backup outside Git.
6. Restore into an empty RDS target under the application owner. Abort if the target already holds application data. Verify all 105 tables, migration registry, columns, indexes, constraints, row counts and deterministic data fingerprints. Verify the source stayed unchanged while copying. Do not start workers during comparison.
7. Prepare the new database URL in a dedicated application secret at runtime. Grant only the required execution role access to it and the encryption key. Point every active application task at RDS, preserving the existing app encryption key. Keep the source stopped as a rollback copy.
8. Validate TLS, health, auth sessions, Forms submit/resume/uploads, Sheets persistence and linked responses, Meet booking/cancellation, and Flow drafts/publish/simulation/permissions/waits. Use synthetic accounts and approved destinations only; no unrequested messages or payments.
9. Lift Flow activation only after every remaining worker runs compatible Flow v1 code and references RDS. Retire the old Render worker after API routing and acceptance are confirmed. Provider-dependent actions remain unavailable until their providers are configured and tested.
10. Record the actual target, backup hashes, data comparison, application task/image revisions, acceptance and rollback boundary. Leave Supabase intact through the agreed rollback period; do not delete the project or its data as part of this request.

## Rollback boundary

Before RDS accepts application writes, return the application tasks to the preserved source configuration. After the first accepted RDS write, blindly switching to the old source would lose or split new data. Pause all writers and reconcile or copy the latest RDS data back before reversing routing. Keep both worker sets from running concurrently against different databases.

## Preparation verification

- AWS CloudFormation template validation: passed.
- AWS inventory and orderable PostgreSQL version/class checks: passed.
- CA-selection and Flow engine/trigger tests: 24 passed, 0 failed, 0 skipped.
- No RDS instance, schema restore, secret change, live cutover or Flow activation occurred during preparation.

Flow provider setup remains separate: SMS/WhatsApp, AI, Slack, external Google Sheets sync and payment-provider verification require the appropriate accounts and credentials. Database migration does not create those integrations.

## First provisioning attempt and permission repair

The owner selected Single-AZ, estimated USD 17.95/month base. CloudFormation accepted stack `schedora-database` but resource creation failed at `DatabaseKey`: unauthorized tagging. Rollback reached `ROLLBACK_FAILED` because the deployment identity also lacks `rds:DeleteDBParameterGroup` and `rds:DeleteDBSubnetGroup`. The names in the failed cleanup are empty setup groups; no RDS DB instance was created. Existing applications and the Supabase source were not paused or modified.

A scoped supplemental policy is prepared at `infra/aws/schedora-database-deploy-policy.json`. It covers the named Schedora RDS instance, its generated groups and secrets, encrypted database logs, project-tagged encryption keys and the RDS service-linked role. It does not grant AdministratorAccess, does not permit reading secret values and does not grant database-instance deletion. Every named action was checked against AWS's programmatic service authorization reference. It requires administrator review before attachment; signing in alone is not treated as permission to attach it.

After permission approval, recover or remove the failed stack before retrying the exact Single-AZ setup. Do not launch duplicate database stacks. Preserve any retained key and generated secrets; inspect actual resource state rather than assuming creation or cleanup succeeded.

## Permission repair, provisioning and full transfer rehearsal

The owner approved creating and attaching `SchedoraDatabaseMigrationDeploy`. The user had reached the ten managed-policy attachment quota. Rather than removing unrelated policies, the exact approved policy was attached through `SchedoraDeploy`, verified to contain only `schedora-v1`.

Subsequent provisioning identified two distinct constraints:

- The AWS account's Free plan rejected seven-day backup retention. The testing deployment uses one day; the template's default remains seven. No account-plan upgrade was made. Increase backup retention when the account plan supports the intended production retention.
- RDS returned a misleading customer-key accessibility error. CloudTrail established that its denied call was `kms:DescribeKey` on AWS-managed key `8b5bb106-6a57-491a-b1f9-d120ef9661bd`. A metadata-only permission for that exact key fixed creation. This permission provides no decryption or secret-value access.

Retained resources are reused across retries: customer KMS key `5427764f-c282-4982-80d8-7d6179b6101d` (rotation enabled), encrypted log group `/aws/rds/instance/schedora-shared/postgresql`, and secret `schedora-database-app`. The active stack is `schedora-database/114a93e0-e7f5-11f1-bdc5-0affc25c11d3`. RDS reports PostgreSQL 17.11, `db.t4g.micro`, Single-AZ, private access, encrypted storage, one-day backups and deletion protection; it is now available; CloudFormation is CREATE_COMPLETE.

The fresh protected source backup was verified by a restore: 105 tables, 337 rows, schema v33, SHA-256 `3e4527e660856c39ab8469bf0ff76e5224656f9e644f1037398419130f19ac3f`. It is outside Git in the owner's private backup directory. This is a preparation backup; take another after the writer pause for cutover.

The one-shot migration image was built and rehearsed using that backup in a disposable TLS-enabled PostgreSQL 17 fixture. The real transfer script restored under `schedora_app` and verified the schema plus every table's deterministic data fingerprint: 105 tables, 337 rows, zero differing tables, source unchanged. A repeat run refused the populated target and left all 105 tables intact. No AWS credential was published by the fixture.

`SchedoraRdsRuntimeMigration.json` and the additive `SchedoraRuntimeBoundary.json` change were approved and applied on 24 November. Additions are restricted to `schedora-web-execution`, the exact new app and owner secrets, and the exact encryption key through Secrets Manager with the secret's encryption context. Owner reads and app-URL publication expire at `2026-11-25T18:30:00Z` (26 November midnight IST); remove them after migration even if they have expired. Existing AppBeta references and permissions are preserved. The deployment user's policy still cannot read secret values.

Current checks: syntax check 307 files passed; database comparison and TLS tests 4/4 passed; full TLS transfer rehearsal passed. IAM Access Analyzer validation was denied to the deployment identity; its validation has not been claimed. Runtime policy additions use the official Secrets Manager encryption-context restrictions documented at https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html .
