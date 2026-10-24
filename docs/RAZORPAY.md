# Razorpay for paid Meet appointments

## Scope

Workspace owners/admins connect their own Razorpay account from Meet → Calendars & apps. INR appointment payments settle to that account. This adapter uses hosted Standard Payment Links; it does not collect card details on Schedora. It does not enable Schedora plan subscriptions or split settlements between Schedora and hosts.

## Customer-paid gateway fees

The requested policy is **processing fees only; no additional Schedora charge**. Schedora sends the appointment's base price unchanged. Razorpay's approved Convenience Fee model calculates and discloses any customer-paid gateway fee and applicable tax in its checkout. Do not manually add 2%, GST, or a separate fee in Schedora: that could double-charge or differ from the account's negotiated pricing and payment-method rules.

Razorpay must activate this feature for the account's eligible business case. Select the Convenience Fee model in Razorpay's Fee Bearer settings only after approval. Changes to Fee Bearer in test mode also apply to live mode. The Schedora checkbox records that the provider configuration is complete; it does not change Razorpay's settings. Leave it unchecked while approval is pending. Without provider activation, Schedora cannot claim it is collecting the processing fee from customers.

The public booking form discloses customer-paid processing charges before redirecting. Razorpay shows the final breakdown before payment. Schedora records the appointment price, not an estimated all-in payment total; Razorpay's payment record is the source for actual fees, tax and gross paid. Free appointments incur no gateway fee through this adapter.

## Owner setup

1. Use Razorpay Test mode first. Generate a test Key ID and secret privately; never paste secrets in chat, Git or frontend environment variables.
2. Create a webhook for `payment_link.paid` using the workspace-specific URL displayed on the connection form: `https://schedora.in/api/payments/razorpay/<workspace-id>`.
3. Choose a private webhook signing secret of at least 16 characters. Enter it and the API credentials in Schedora's connection form yourself. Schedora verifies API access and encrypts the credentials in its database.
4. If approved/enabled by Razorpay, confirm customer-paid fees using the checkbox. Otherwise leave the checkbox off and request activation from Razorpay.
5. Publish a hidden INR test event. Complete checkout with Razorpay's test payment methods; verify the final fee breakdown, signed webhook, one confirmed booking, Google event and email. Test payment failure, abandonment, expiry and duplicate webhooks.
6. Owner completes KYC/account activation, confirms fee eligibility and refund terms, then replaces the test credentials with live credentials. Reconcile pending payments first. A live transaction/refund requires owner action.

## Payment safeguards

- Only admins/owners may connect payment credentials. Clients cannot choose the charged amount or recipient account.
- Payment holds last 20 minutes for Razorpay. Paid Razorpay event types have at least 20 minutes' notice. Razorpay requires a link expiry at least 15 minutes in the future, so a new link is not issued with less than 16 minutes left in its hold; existing links remain reusable until expiry.
- A unique provider reference and link recovery avoid creating a second checkout after an interrupted request. Concurrent requests in one process share one checkout operation.
- Browser success parameters do not prove payment. Schedora fetches link status using server credentials. Signed `payment_link.paid` webhooks use HMAC-SHA256 over the raw request body; provider state, workspace, booking reference, currency and full base amount are verified.
- Duplicate callbacks do not confirm or email twice. Test-payment simulation cannot bypass a connected real provider, including a connected Razorpay test account.
- Late payment never resurrects a canceled/expired booking or steals a reassigned slot. It is recorded as paid on the canceled booking and flagged for host refund review. No automatic financial refund is executed.
- Checkout failure returns the saved pending booking and its recovery page, rather than falsely displaying confirmation.

## Outstanding live validation

Account check on 24 October 2026: schedora.in is approved. Razorpay's Fee Bearer page currently selects merchant-paid fees; its customer-paid option is disabled and directs the owner to support about incompatible products/features. Customer-paid processing is therefore **not activated**. Do not bypass this restriction by adding a manual surcharge, and do not disable other Razorpay products without owner review.

Automated tests substitute Razorpay HTTP responses. Account credentials, webhook activation, provider-side convenience-fee approval and a real Razorpay Test-mode checkout still need owner configuration and verification. Do not describe the gateway or fee collection as live until that is done.

## Official references

- [Convenience fees and eligibility](https://razorpay.com/docs/payments/dashboard/account-settings/configuration/convenience-fees/)
- [Create Standard Payment Links](https://razorpay.com/docs/api/payments/payment-links/create-standard/)
- [Fetch Payment Links by reference](https://razorpay.com/docs/api/payments/payment-links/fetch-all-standard/)
- [Webhook verification](https://razorpay.com/docs/webhooks/validate-test/)
- [Current pricing](https://razorpay.com/pricing/)
