# Schedora project checkpoints

Last updated: 2026-11-12

## November 13 morning checklist

Launch target: Meet, Forms, and Flow. Product design and UX approval, end-to-end acceptance, and production deployment are still open. The items below are the work to verify before committing to the morning launch.

- [x] AWS web staging deployed. CloudFormation update and ECS rollout completed, and `https://staging.schedora.in/api/health` returned HTTP 200 with the database healthy. This confirms the staging deployment; it does not validate individual product journeys.
- [ ] Meet: verify shared sign-in, scheduling, booking, and cancellation. If video is in the release, enable staging video and complete a two-browser LiveKit call with audio and video. The LiveKit endpoint responded over HTTPS; meeting video in the app was still disabled at handoff.
- [ ] Forms design: review the current Typeform-inspired builder, then agree on a distinct Schedora design. Apply clear hierarchy, consistent spacing and controls, accessible keyboard and focus behavior, and responsive layouts. Make adding, editing, reordering, previewing, and publishing easy to find. Get product design and UX approval.
- [ ] Forms data: trace a submission from the published form through storage, response views, and export. Verify field mapping, validation, draft versus published behavior, and handling of existing data.
- [ ] Flow research and implementation: review automation tools and patterns, inventory the integrations and capabilities already working, and prioritize which ones to ship. Implement the selected triggers, actions, and connectors. Give users clear setup, validation, run history, error details, and retry controls. Verify representative workflows end to end and get UX approval.
- [ ] Release: verify deployment and rollback, production HTTPS and database connectivity, and the intended production routes for all three products. Cut over customer DNS only after release checks pass. Keep `schedora.in` as the landing page and route Meet through `meet.schedora.in`.

The AWS section below contains earlier checkpoints. Use the verified staging status above for the current handoff.

### November 13 work started

- LiveKit video is required for this release. The AWS staging LiveKit endpoint responds over HTTPS, but Meet's video flag is off. Before enabling it, configure and verify signed LiveKit webhooks, confirm monitoring, review self-hosted room auto-creation and token revocation, and complete a real two-browser smoke test. The current AWS deployment identity is denied Systems Manager access to the LiveKit staging instance.
- Meet staging API smoke passed: shared sign-in from the staging homepage to Meet, event publishing, invitee booking, and host cancellation reflected on the invitee side. Removed the disposable QA account and workspace afterward.
- Meet staging booking confirmation email passed end to end. The AWS rollout enabled the HTTP email provider, which accepted the test confirmation on the first attempt. The user confirmed receipt in Gmail. The disposable QA workspace was removed. Staging continues to use the shared database as agreed.
- [ ] Meet Overview → Booking Options → Your event types: use a compact, content-sized Draft badge with the dot and label on one line. Keep the Edit button aligned and verify long titles and narrow screens in both themes. The staging screenshot shows the badge stretching across the row.
- [ ] Meet dark theme: review icon visibility and contrast, including hover, focus, selected and disabled states. Use dark theme colors or alternate icons where needed. Capture any additional findings from the user's manual review before moving to Forms and Flow.
- Staging CloudFormation reported `UPDATE_COMPLETE`. The homepage, login, Meet, Forms and Flow routes returned HTTP 200. The health endpoint reported PostgreSQL and the worker healthy, video disabled, and two release warnings. These are availability checks; signed-in staging journeys still need acceptance.
- Local focused acceptance passed 25 checks covering shared sign-in, Forms draft and published data, response storage and export, Flow retry behavior, and Meet platform behavior.
- The first local browser run passed sign-up, event publishing, invitee booking and rescheduling. It failed on several later journeys. Updated Forms and Flow test entry points for the current navigation and direct draft creation; the separate template-picker check remains open.
- Browser rerun: 1,032 layout checks and 17 failed journeys. Form build/publish, classic and conversational submission, response inbox/CSV, Flow creation and booking-triggered runs passed. Remaining failures include Forms keyboard navigation and mobile layout, Meet readiness and video, billing, and onboarding. Production acceptance remains open.
- Forms design proposal for review: put the question list beside the active question editor, with Preview as a separate action and one clear Publish button. On narrow screens show one working surface at a time, retain the selected question when switching, and return keyboard focus to the control that opened Preview. Show whether edits are saved and whether the published form has pending changes. Preserve published versions and existing submissions during the redesign.
- Flow already supports booking created, canceled and rescheduled events and Forms submissions in the backend, with email and task actions, run history and failed-run retries. The local editor now exposes the two missing booking triggers and labels them correctly in run history. Verify booking event to action before shipping.
- For Flow's next iteration, prioritize conditional filters and clearer failed-run details before adding more connectors. Show why a run stopped, which action failed, and what retry will do. [Zapier filter behavior](https://help.zapier.com/hc/en-us/articles/30577165587213-Zap-filters-are-not-working-properly), [Zapier replay](https://help.zapier.com/hc/en-us/articles/19220226086797-What-is-replay), [Make incomplete executions](https://help.make.com/incomplete-executions?cb=1).
- Production HTTPS blocker: both ACM requests for `meet.schedora.in` failed with `CAA_ERROR`. Public DNS follows a Vercel CNAME whose CAA records do not list an Amazon issuer. Plan certificate issuance with the current DNS provider before switching production traffic. [AWS ACM CAA troubleshooting](https://docs.aws.amazon.com/acm/latest/userguide/troubleshooting-caa.html).

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
- The GitHub Actions workflow has a Meet deployment job after CI on `main`, plus a manual LiveKit staging deployment option. The Meet certificate ARN variable update is still blocked by GitHub email identity verification; the existing value is not the pending replacement certificate. The LiveKit job also needs the generated cloud-init stored as an encrypted Actions secret.
- Workflow, infrastructure templates, policies, deployment notes, and focused billing test fixes are committed to the isolated GitHub branch `codex/aws-deploy-pipeline`. They are not merged to `main`; no Meet ECS/ALB stack or LiveKit EC2 stack has been deployed.
- Latest GitHub Actions run passed on commit `80ea74121f309013813b3ba3e175d7a78719dca1`: syntax/shared-file/SDK checks passed; 400 backend tests had 392 pass, 0 fail, and 8 skipped; PostgreSQL migration/release rehearsal passed; all browser journeys passed with 1,168 layout checks across 320/375/768/1280 px in light and dark themes. Both AWS deployment jobs were skipped on the feature branch.

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
4. Reauthenticate the AWS connection, confirm ACM issued the replacement Meet certificate, and finish GitHub email identity verification so `SCHEDORA_MEET_CERTIFICATE_ARN` points to that certificate.
5. Save the generated LiveKit cloud-init as an encrypted GitHub Actions secret; do not commit it. Then merge the reviewed branch to `main` to run the gated Meet deployment and manually start LiveKit staging when ready. Validate both and check AWS spend. Keep existing production providers until staging acceptance and rollback checks pass.

