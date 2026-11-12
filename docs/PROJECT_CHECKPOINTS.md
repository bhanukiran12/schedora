# Schedora project checkpoints

Last updated: 2026-11-12

## Product and UI decisions

- Keep the marketing landing page in light theme regardless of the device theme or dashboard preference.
- Let each signed-in user choose System, Light, or Dark in Appearance for the dashboard. Dark mode should use near-black surfaces, readable high-contrast text/icons, and Schedora green for primary buttons and restrained accents. Use subtle gradients from the existing palette; do not turn large backgrounds green or introduce amber.
- Apply the same theme and button treatment consistently across Meet, Forms, and Flow. Keep mobile and tablet layouts usable at their actual device widths.
- Landing-page positioning: Meet scheduling first, then Forms, then Flow. Remove “for consultancies, agencies and service teams.”
- Keep profile access visible while scrolling. Use clear account/workspace labels and avoid repeated “Meet workspace/setup” headings.
- Keep Help and Setup concise: no unnecessary demo/go-to links or large readiness cards. Show the actual booking/share link when available; validate required fields as the user fills the form.
- Make event/poll and booking screens compact. Fix the Draft badge sizing, spacing between instant/scheduled meeting choices, and timezone controls overlapping weekday time slots.
- Keep subscription details compact. Privacy choice should be asked once, use familiar clear choices, and remember the selection.
- Use one Schedora sign-in across Meet, Forms, and Flow. A local shared-cookie fix moved product subdomains under `schedora.localhost`; the user reported the new local sign-in worked, but recheck each product and API session before claiming the full journey passes.
- Prior browser work reported responsive layout measurements without horizontal overflow, but 47 browser journeys failed at that time. Treat journey acceptance as open until rerun on the current checkout; historical results are not proof of current readiness.

## AWS staging plan and current verified state

### Update: November 12, 2026

- GitHub repository variables are present for the deploy role, `AppBeta` secret ARN, Mumbai VPC, and two public subnets. The `SCHEDORA_MEET_CERTIFICATE_ARN` update is still pending GitHub email identity verification; do not claim it is saved yet.
- The earlier ACM request for `meet.schedora.in` is `FAILED`. A replacement request is `Pending validation`. Its DNS CNAME name and value are identical to the record the user just added in GoDaddy; DNS resolves to the AWS validation target. Keep that CNAME in place; no second record is needed. Wait for ACM to transition to `ISSUED`.
- `SchedoraRuntimeBoundary` now allows `secretsmanager:GetSecretValue` for existing `schedora-*` secrets and the exact `AppBeta` secret ARN. AWS confirmed the policy update succeeded. The secret values were not opened or inspected.
- LiveKit's official VM generator ran locally for `lk-stage.schedora.in` and `turn-stage.schedora.in`, pinned to `v1.13.11`, bundled Redis, and Ubuntu cloud-init. Output, including generated staging-only credentials, is in the git-ignored `infra/aws/livekit-staging/generated/` directory. Do not commit or display its contents. The EC2 stack has not been deployed; DNS A records must point to its Elastic IP only after creation.
- The local GitHub Actions workflow now has a Meet deployment job after CI on `main`, plus a manual LiveKit staging deployment option. The Meet certificate ARN variable update is still blocked by GitHub email identity verification; the existing value is not the pending replacement certificate. The LiveKit job also needs the generated cloud-init stored as an encrypted Actions secret.
- Checkout files remain local and unpushed. No Meet ECS/ALB stack or LiveKit EC2 stack has been deployed.
- Current local verification: workflow YAML parses, `git diff --check` is clean aside from existing CRLF notices, `npm run check` passed for 204 files, and the backend suite passed 397 tests with 7 PostgreSQL-only tests skipped. GitHub Actions has not run for these local changes.

- Move the Schedora web app and LiveKit to AWS staging. Keep Supabase unchanged. Keep Render and LiveKit Cloud serving production until staging acceptance; do not change production DNS as part of staging.
- Region: `ap-south-1`. App architecture: Docker image in private ECR, ECS Fargate behind HTTPS ALB. LiveKit is a separate EC2 staging host. Use staging-only hostname and credentials.
- AWS CLI identity verified as `schedora-v1` in the intended account; root credentials were not used.
- `SchedoraDeploy` group contains only `SchedoraDeployPolicy` and one member. Nine unrelated policies were removed from that group. Policies directly attached to the IAM user were not changed, and the deployment identity cannot list them.
- `schedora-ecr` stack and private immutable scan-on-push ECR repository are created. The current checkout image `staging-20261112-01` is pushed and active.
- `SchedoraDeployPolicy` now permanently includes `acm:RequestCertificate`, restricted to `ap-south-1` and domain names under `staging.schedora.in`. The policy JSON source is `infra/aws/SchedoraDeployPolicy.json`.
- To fit AWS's 6,144-character customer-managed policy limit, `cloudformation:CancelUpdateStack` was removed from the final policy; normal deployment operations remain available, but this identity cannot manually cancel a stack update.
- ACM certificate for `staging.schedora.in` and `*.staging.schedora.in` is pending DNS validation. Add this CNAME in GoDaddy; it validates both names:
  - Name: `_659d1091f58718204d22fb8eb6389378.staging.schedora.in.`
  - Value: `_e026ac532e4645b24f1a7c73bfd8b184.wzccmgtwzk.acm-validations.aws.`
- The web template passes AWS `validate-template`; the default VPC has public subnets across multiple AZs. No ECS app service, ALB, LiveKit VM, or DNS record has been created.

## Next steps

1. Complete GitHub's email verification to save the replacement `meet.schedora.in` certificate ARN, then wait for ACM status `ISSUED`.
2. Confirm the `AppBeta` JSON secret contains the current app values and required keys. Its values were not inspected. Preserve Supabase and the existing encryption key; do not send `.env` or secrets in chat.
3. Save the generated LiveKit cloud-init as an encrypted GitHub Actions secret; do not commit it. The local generated output contains staging credentials.
4. Push the reviewed workflow/template files to GitHub and run CI. Do not trigger the main deployment until the certificate is issued and secret contents are confirmed.
5. Deploy the Meet stack and LiveKit staging stack, validate both, and check AWS spend. Keep existing production providers until staging acceptance and rollback checks pass.

