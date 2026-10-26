# Google sign-in and production setup

Implemented 26 October 2026. Google account sign-in is separate from Meet's optional calendar integration.

## Server configuration

Existing `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` can be reused. Optionally set `GOOGLE_SIGNIN_CLIENT_ID` and `GOOGLE_SIGNIN_CLIENT_SECRET` for a dedicated sign-in client. Keep secrets in Render, never in frontend files. Production also requires the existing `APP_ENCRYPTION_KEY`.

Set `BASE_URL=https://schedora.in`. The exact sign-in authorized redirect URI is:

`https://schedora.in/api/auth/google/callback`

Preserve the existing calendar callback (`/api/oauth/google/callback`, on the API base URL already configured). Do not replace it with the sign-in callback. Shared product sessions use the existing Secure, HttpOnly, SameSite=Lax session configuration and COOKIE_DOMAIN.

## Account behaviour and security

- `/account` offers Continue with Google when server credentials are configured.
- Google scopes: `openid email profile`; no Calendar scopes or offline access are requested during sign-in.
- Authorization code exchange and client secret stay on the server. PKCE, encrypted HttpOnly flow cookies, one-time persisted state and nonce protect the flow. Signed RS256 tokens are verified against Google's fixed JWKS endpoint; issuer, audience, authorized party, issue/expiry times and verified email are checked.
- Users are identified by Google `sub`, not email. No Google login access or refresh token is persisted.
- New users get an account and owner workspace. Existing password accounts must sign in first, then choose Connect Google sign-in in Account. Emails must match; there is no automatic linking by email alone.
- Enforced organization SSO cannot be bypassed with Google sign-in.
- Google-only users can request deletion from Account, type DELETE, and reauthenticate with the already-linked Google identity. Starting a flow does not delete anything; successful bound identity verification performs the existing account/workspace cleanup.
- Errors return to Account with a readable message, without exposing token/provider responses.
- SQLite migration 004 and the additive PostgreSQL migration create auth_identities and auth_login_flows. Existing users/passwords/calendars are preserved.

## Google Cloud production checklist

1. Branding: app name Schedora, homepage https://schedora.in/, privacy https://schedora.in/privacy, terms https://schedora.in/terms, authorized domain schedora.in and monitored support/developer contacts.
2. Clients: add the exact login redirect above to the current Web client, preserving calendar redirects and origins.
3. Audience: change Testing to In production when Google's configuration checks permit. Publishing removes the test-user-only restriction; it does not by itself mean sensitive-scope or brand verification is approved.
4. Verification Center: complete required brand/domain and Calendar sensitive-scope verification. Do not label draft policy content or unverified scope access as approved. Provide owner-approved operator/privacy contact details and any Google-requested demo/justification.
5. Test password-account linking, Google-only signup, repeat login, consent cancellation, sign-out and account deletion with controlled accounts. Use a separate Google project/client for future development/testing; keep the production project/configuration stable.

The Google app's publishing/verification status is controlled in Google Cloud, not by application code or the presence of a client secret.

Official references:
- https://developers.google.com/identity/openid-connect/openid-connect
- https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance
- https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
