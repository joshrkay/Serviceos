# B1 — Setup (agent report, verbatim rows + key sections)

## Rows

| Req | Rung | Evidence | Missing link |
|---|---|---|---|
| B1.1 | 3 | `packages/web/src/components/auth/LoginPage.tsx:65` Clerk `<SignIn>` (email+password + OAuth); tenant bootstrap on `user.created` webhook, `packages/api/src/webhooks/routes.ts:330,820-830` (`bootstrapTenant()`) | Google actually enabled is Clerk-dashboard config (C8-class, UNKNOWN) |
| B1.2 | 4 | `test/db/schema.test.ts` "every table with tenant_id also FORCEs RLS" — ran, 17/17 passed; 119/119 tables with ENABLE also FORCE; 2 documented exemptions (`oauth_states`, `platform_deprovision_log`) pinned at `test/db/schema.test.ts:199-207` | — |
| B1.3 | 3 | `packages/api/src/routes/users.ts:110-130`; `users` tenant-scoped FORCE RLS (`schema.ts:3260`) | — |
| B1.4 | 2 | `packages/api/src/auth/rbac.ts:1` — Role = owner|dispatcher|technician; DB CHECK `schema.ts:46` same 3. No `admin` anywhere. Technician-cannot-approve solid: `ROLE_PERMISSIONS.technician` (`rbac.ts:183-243`) omits `proposals:approve` | `admin` role specced, never built |
| B1.5 | 3 | Invites wired: `routes/users.ts:703-786` persists + Clerk + `user.invited` audit; web `TeamMembersSheet.tsx`. But Clerk redirect `${appBaseUrl}/accept-invitation?...` (`users.ts:732`) has NO matching route in `packages/web/src/routes.ts` (254 lines, none) | Invited user lands on unrouted URL; no 2–3-question tech setup component exists |
| B1.6 | 3 | `proposals/actions.ts:230-258` approval audit `{id, role}` + channel (RV-073); `routes/users.ts:151-168,278-290` actor-attributed audits | — |
| B1.7 | 2 | `StripeConnectService` wired (`app.ts:1087-1147,5073`). BUT `invoices/public-invoice-service.ts:235-250` documents+implements silent fallback to the PLATFORM Stripe account when Connect not active; `invoices/invoice-payment-link.ts:57-61` same | "Rivet never holds tenant funds" actively violated by design for un-onboarded tenants |
| B1.8 | 5 | `packages/web/src/components/settings/PaymentMethodsSheet.tsx` — GET /api/billing/connect, POST /connect/onboarding → Stripe-hosted link, DELETE; backend `routes/billing.ts:120-210`, `app.ts:5073` | — |
| B1.9 | 5 | `PaymentMethodsSheet.tsx:114-210` renders pending/active/restricted/disconnected; `mapAccountToStatus` (`stripe-connect.ts:123-134`) incl. `restricted` from `requirements.disabled_reason` | — |
| B1.10 | 2 | `routes/terminal.ts:48-68` gates card-present with `CONNECT_REQUIRED` (409). But `notifications/send-service.ts:278-306` `sendInvoice()` never checks Connect; `routes/invoices.ts:435-463` mints payment link unconditionally → silent platform fallback | No Connect gate on the primary invoice/payment-link flow |
| B1.11 | 5 | `InvoicePaymentPage.tsx:8-11,333`, `PortalPaymentMethods.tsx:10,41` — Stripe Elements/PaymentElement only, no raw card fields | — |
| B1.12 | 3 | `stripe-connect.ts:4-10` documents Billing vs Connect separation; separate columns + routers | — |
| B1.13 | 5 | `onboarding/v2/steps/PhoneStep.tsx`: area-code search → pick → claim → status polling + retry | — |
| B1.14 | 3 | `IdentityStep.tsx:72-75,141-152,230-262` captures service area text/radius/zips → `/identity` | Not consulted by B2 interpretation (see B2 report) |
| B1.15 | 3 | Timezone editable Select prefilled by `detectBrowserTimezone()` (`IdentityStep.tsx:38-40,79,275-279`); seeders no longer guess (commits c020eb5/03485f8); ran `test/routes/onboarding-phone.route.test.ts` → 9/9 incl. regression | Prefill-is-a-soft-guess tension flagged, judged compliant |
| B1.16 | 3 | `settings/PriceBookPage.tsx` real settings page; `catalog_items` FORCE RLS (`schema.ts:1032`) | Import→catalog-resolver wiring not fully traced (conservative 3) |
| B1.17 | 2 | `verticals/packs/electrical.ts` registered but self-labeled `training_tier: 'second_class'` "basic residential triage". Zero repo matches: AHJ, permit line item, two-person, license verification | A8 Reversal-1 electrical feature set entirely absent |
| B1.18 | 3 | `settings/BrandVoiceSheet.tsx` 6 fields, versioned, cooldown; `brand_voice_versions` (`schema.ts:5918-5933`) + `tenant_settings.brand_voice_locked` (`schema.ts:5948`) | 🎙️ tag unmet — capture is web-form only, no spoken path |
| B1.19 | 3 | `ai/orchestration/onboarding-conversation.ts` — real multi-turn FSM, persisted sessions (`onboarding_session`, FORCE RLS `schema.ts:4871`), clarification loop, 5 extractors; route `app.ts:5488-5501`. grep web+mobile for callers → ZERO | Backend engine real+wired; no client calls it. Shipped UX is the V2 form wizard |
| B1.20 | 3 | `OnboardingGuard` (`ProtectedRoute.tsx:66-93`) soft-gates; `UpgradeNudgeBanner` in `Shell.tsx:24,413` | Inline dependency-gap notes not confirmed |

## Watchlist re-verification

- Connect onboarding UX: MOVED/INVERTED — real Settings UI wired (B1.8/B1.9 rung 5); new unseeded finding: silent platform-account fallback on invoice payment links (B1.7/B1.10 violated by design; only Terminal gates correctly).
- Conversational onboarding: backend seed REFUTED (real turn loop + session persistence); reachability seed CONFIRMED (zero callers; shipped flow is the form wizard).
- Electrical pack: CONFIRMED specced-not-built beyond a second-class triage pack.
- Timezone guessing: CONFIRMED removed (test-verified).
- Phone provisioning: CONFIRMED rung 5.

## Deltas

- B1.4: 4 roles specced, 3 built (`admin` absent from rbac.ts + DB CHECK).
- B1.7/B1.10: PRD invariant contradicted by intentional, commented platform-fallback code.
- Reality ahead: conversational-onboarding backend more capable than seed claimed (gap is reachability).
- Reality ahead + new gap: invite backend complete but `/accept-invitation` client route missing entirely.

## Judgment calls (verbatim from agent)

- B1.10 rung 2 (Present-but-misapplied): correct gating exists on Terminal path only.
- B1.19 rung 3: registered with real deps = Wired; capped below 5 for zero reachability.
- B1.1 Clerk OAuth mechanism = rung 3; Google toggle is runtime UNKNOWN.
- B1.16 conservative 3 without full import-flow trace.
- B1.15 prefilled-but-confirmed timezone judged compliant, tension flagged.
