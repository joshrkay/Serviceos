# Rivet Stripe plan alignment

The onboarding endpoint used one stale STRIPE_PRICE_ID for every signup. Both Development and production returned Stripe resource_missing for that price. The API keys already belonged to the correct Rivet live account and its separate sandbox.

## Customer behavior

The billing step requires an explicit Basic (USD 50/month) or Enterprise (USD 150/month) selection, with no default. The API accepts only the plan ID, resolves its environment-specific Stripe price, and validates the active product, monthly interval count of one, licensed usage, USD currency, and expected amount before creating checkout. Price lookups have a ten-second timeout. Invalid configuration fails closed instead of charging a different price.

Stripe-hosted checkout retains the 14-day trial and required payment collection, collects billing address and updates the Stripe customer name/address. The owner email comes from the authenticated account. Subscription metadata includes the Rivet tenant ID, selected plan, Stripe product ID, and Stripe price ID. Card details remain at Stripe. This change does not introduce tier-specific entitlements or mirror billing address into Rivet's database.

Existing advisory locking and pending-checkout guards remain. The HTTP route has no fallback plan. The deprecated STRIPE_PRICE_ID path remains for scripts/provision-tenant.ts and older direct service callers; it is not used by the new web flow.

## Environment and delivery configuration

Set STRIPE_BASIC_PRICE_ID and STRIPE_ENTERPRISE_PRICE_ID to the matching recurring prices in each account. Live and sandbox IDs must differ. Both Railway API environments have the new per-plan values prepared. Development applied its configuration via successful deployment 55166e92-3825-42bd-af2f-e30ddbf3295a; production picks up its new variables on the next deploy. The application change still requires merge and deployment.

A sandbox endpoint now sends customer.subscription.created/updated/deleted and checkout.session.completed/expired to the Development API. Its signing secret was deployed. The existing production endpoint with a verified signing-secret match now also includes subscription-created/updated/deleted, preserving its existing events. Connected-account payment routing remains a separate verification gate.

## Validation

- 97 focused API billing, onboarding route, and route-manifest tests pass.
- 9 frontend billing tests pass, including explicit selection, keyboard operation, pending state and neutral errors.
- Playwright offline SPA tests pass at 320px and 390px: no horizontal overflow, labels at least 44px tall, keyboard plan selection, and only the chosen plan sent.
- API production tsconfig and web typecheck pass. No DB queries or schema changed.
- Real Stripe sandbox checkout API calls for both configured plans returned HTTP 200 with billing_address_collection=required and payment_method_collection=always. Both test sessions were expired afterward.
- An isolated sandbox subscription created/deleted delivery test returned HTTP 200 from the API for both actual Stripe events. The test subscription was canceled and had no Rivet tenant mapping. This verifies delivery and signing, not customer provisioning.

## Release gate

After merge/deploy, run the fresh-account hosted-checkout flow through tenant-linked trial activation, webhook reconciliation, phone/AI provisioning and first value. Those outcomes remain unverified. No live charge or subscription was created by this validation.
