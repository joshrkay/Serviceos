# QuickBooks sandbox — is row 9.11 provable at rung 5? (ticket #1003)

**Question (from `docs/PRD-v5-as-built.md` row 9.11, wayfinder map #995):** *As S, I want
paid invoices to reach QuickBooks without me re-keying them.* Acceptance: already-synced
paid invoices swept again make zero QuickBooks calls and zero new `sync_log` rows;
pagination syncs every paid invoice; `sync_log` is RLS-isolated. Today: rung **4 ↑** via
`packages/api/test/integration/accounting-sync.test.ts`. The PRD's note: *"Rung 5 is
blocked on a live OAuth connection, not on code."*

Per §8.0 of the PRD, rung 5 requires **reachability**: a normally-provisioned tenant gets
there with no SQL, no platform-admin action, no environment variable — i.e. a hermetic
Playwright run in which an owner completes the QuickBooks connect flow from the shipped
settings UI and a paid invoice lands in QuickBooks.

## Answer: NO — not with *nothing beyond* a free developer app

Almost everything the PRD's note assumes is blocked on Josh turns out to be self-service:
a free Intuit Developer account auto-provisions a sandbox company, sandbox supports the
full OAuth 2.0 authorization-code grant and every Accounting API call this code makes,
`localhost` redirect URIs are explicitly allowed for Development/sandbox keys, and the
sandbox's rate limits/pagination are documented as identical to production. **The one
piece that cannot be self-provisioned by an agent is the interactive OAuth consent
click itself** — Intuit documents no client-credentials/service-account flow, so a human
holding a real Intuit login must complete the authorization screen at least once, and
Intuit's Developer Terms of Service do not clearly authorize automating that click. That
is a genuine, structural blocker, not an excuse — but it is a *smaller* blocker than "a
live OAuth connection" implies, because the resulting refresh token is reusable for up to
100 days (rolling) / 5 years (hard ceiling) without repeating the interactive step. See
"Independent finding" below for a second, code-side gap that would also cap this row at 4
even if the OAuth question were solved today.

## What the shipped code actually does (read from `origin/main`, 2026-09-11)

- **OAuth implementation**: hand-rolled (no Intuit SDK), in
  `packages/api/src/integrations/accounting/quickbooks-oauth.ts`. Authorization URL is
  built against `https://appcenter.intuit.com/connect/oauth2` with scope
  `com.intuit.quickbooks.accounting`; code exchange and refresh both POST to
  `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` with HTTP Basic auth
  (`client_id:client_secret`).
- **Env vars read** (`resolveQuickBooksOAuthConfig`, `resolveQuickBooksEnvironment`):
  `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` (both required — the whole feature is
  disabled server-side if either is missing), `QUICKBOOKS_REDIRECT_URI` (optional, else
  defaults to `${apiBaseUrl}/api/integrations/quickbooks/callback`), `QUICKBOOKS_ENVIRONMENT`
  (`sandbox` or `production`, defaults to `production` if unset — a hermetic run must set
  this explicitly to `sandbox`). None of these appear in `.env.example`.
- **API base URLs**: `https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}` vs
  `https://quickbooks.api.intuit.com/v3/company/{realmId}` (`quickbooks-oauth.ts`).
- **Settings UI has a connect button**:
  `packages/web/src/components/integrations/QuickBooksConnect.tsx` calls
  `POST /api/integrations/quickbooks/connect`, then `window.open(url, '_self')` — i.e. it
  navigates the current tab to Intuit's real hosted consent URL. There's also a manual
  "sync now" surface (`triggerQuickBooksSync` → `POST /api/integrations/quickbooks/sync`,
  wired in `packages/api/src/routes/integrations.ts`), so an E2E run does not have to wait
  for the 5-minute cron (`packages/api/src/app.ts:6292`) to observe a push.
- **What the sync actually calls on QuickBooks**: `QuickBooksClient` (`quickbooks-client.ts`)
  only issues `POST /customer` and `POST /salesreceipt`. **It never calls the Accounting
  API's Invoice entity or its query endpoint at all.** The "pagination" the row's
  acceptance clause asserts is `AccountingSyncService.syncIntegration`'s own loop over
  `invoiceRepo.findByTenant(...,{limit,offset})` — ServiceOS's internal Postgres invoice
  table — not an Intuit `SELECT * FROM Invoice STARTPOSITION … MAXRESULTS …` call. This
  matters for the research below: Intuit's Invoice-query pagination behavior is
  irrelevant to whether *this* row's pagination clause is provable; it would only become
  relevant if the story is later changed to *pull* invoices from QuickBooks rather than
  push sales receipts.
- **RLS is real, not aspirational**: migration `172_create_accounting_integrations`
  (`packages/api/src/db/schema.ts:4286`) puts `accounting_integrations` and
  `accounting_sync_log` under `ENABLE/FORCE ROW LEVEL SECURITY` with a
  `tenant_id = current_setting('app.current_tenant_id', true)::uuid` policy, and the
  existing D: test proves it by running raw queries under a `NOBYPASSRLS` role
  (`rls_app_runtime`) with no `tenant_id`/`integration_id` predicate — the policy alone
  gates cross-tenant visibility.
- **Existing rung-4 proof** (`accounting-sync.test.ts`) mocks only the QuickBooks
  `fetchFn` (customer/salesreceipt HTTP responses); everything else (Postgres writes,
  RLS, the pagination loop, dedupe via `sync_log`) runs for real. It never exercises the
  OAuth authorization/token-exchange leg — integrations are seeded directly via
  `integrationRepo.upsert(...)`, bypassing `/connect` and `/callback` entirely.

## Primary-source findings (developer.intuit.com)

All fetched directly from the live pages on 2026-09-11 unless noted as secondary.

**1. Sandbox companies are free and self-service.** Creating a developer account
auto-provisions one sandbox company ("you automatically get a sandbox company" /
"you automatically start with a US-based sandbox when you create your developer
account"). Up to 10 sandbox companies are allowed per developer account, each valid two
years. A sandbox can be reset in place ("Clear data and reset" — wipes data, keeps the
company) or deleted and recreated ("Delete entire sandbox"), both from the developer
account's sandbox list. Region/SKU (QBO Plus vs Advanced) is fixed at creation; changing
it requires a new sandbox.
Source: <https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes/manage-your-sandboxes>
Source: <https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes/sandbox-faqs>

**2. Sandbox supports the full OAuth 2.0 authorization-code grant, no app review
gate.** Intuit's own OAuth Playground doc: "generates sample requests and responses to
demonstrate each step of the OAuth 2.0 … process … shows you how to get authorization
codes, create requests to exchange authorization codes for access and refresh tokens, use
access tokens to make API calls" — run against **Development** keys picked from "one your
sandbox companies," with no production/review step described anywhere in the setup
walkthrough (Steps 1–17 of the main OAuth doc).
Source: <https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0-playground>
Source: <https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0>

**3. `localhost` redirect URIs are explicitly permitted — but only for Development
keys.** "Tip: You can add localhost (no HTTPS) as a URI for sandbox environments." For
Production: "HTTP redirect URIs must be protected with TLS security. The Intuit OAuth 2.0
Server can only redirect to URIs beginning with https. IP addresses aren't allowed."
Source: <https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/set-redirect-uri>

**4. Credentials are Client ID + Client Secret, retrieved per-app.** Docs use these exact
names: under an app's "Keys and credentials," select **Development**, toggle "Show
Credentials," "Retrieve or copy the Client ID and Client Secret" (a separate
**Production** tab holds the production pair — never mix them). Whether a *separate*
sandbox-company login exists (distinct from the developer-account login used to view/reset
sandboxes) is **not stated either way** in the primary docs — every sandbox instruction is
phrased in terms of the same developer-account sign-in, but no page affirmatively rules out
a distinct company-user login being required at the OAuth consent step itself.
Source: <https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes/manage-your-sandboxes>

**5. Token lifetimes.** Access token: "valid for 60 minutes (3,600 seconds)." Refresh
token: "a rolling expiry of 100 days … If 100 days pass, or your refresh token expires,
users need to go through the authorization flow again," refreshable programmatically
before then; `x_refresh_token_hard_expires_in` documents "the remaining time … left in the
token's five-year lifespan" as the hard ceiling underneath the rolling window. The doc says
to "always store the latest refresh_token value from the most recent API server response"
but **does not explicitly state** that the prior refresh token is immediately invalidated
on rotation — that exact behavior is not specified in this primary source.
Source: <https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0>

**6. Rate limits — identical in sandbox and production as of the current docs.** REST
endpoints: 500 requests/minute per realm; 10 requests/second per realm+app; 40 emails/day
per realm. Batch endpoint: 40 batch requests/minute per realm+app, 120/minute per realm,
≤30 payloads recommended per batch. Cross-API combined cap: 800 requests/minute per
realm+app. `429` handling per Intuit's own doc: "wait 60 seconds before retrying" (a flat
wait, not a `Retry-After`-header contract — note the repo's own retry logic in
`quickbooks-client.ts` reads a `retry-after` header and falls back to 2s×attempt, which is
more aggressive than Intuit's documented guidance). Requests over 120 seconds time out.
Source: <https://developer.intuit.com/app/developer/qbo/docs/learn/limits-and-throttles>
Secondary, archived (live blogs.intuit.com URL now redirects elsewhere; content confirmed
via Wayback Machine): sandbox's 10 req/sec-per-realm+app throttle was rolled out
2025-09-15 specifically "to put it on par with Production limits," consistent with the
current table.
Source (secondary): <https://web.archive.org/web/20251011070527/https://blogs.intuit.com/2025/08/13/upcoming-changes-to-the-accounting-api/>

**7. Invoice entity query + pagination is identical in sandbox and production.** The
Invoice entity reference documents "Query an invoice" via
`GET /v3/company/<realmID>/query?query=<selectStatement>` against either
`https://quickbooks.api.intuit.com` (production) or `https://sandbox-quickbooks.api.intuit.com`
(sandbox), with a sample response carrying `startPosition`/`totalCount`/`maxResults`.
Source: <https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice>
The general query-syntax doc uses **Invoice itself** as the pagination worked example:
"suppose you have 25 invoices. The following query gets invoices 1-10:
`SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 10`," with continuation examples for
11-20 and 21-25; max page size 1,000, default 100 if unspecified. No sandbox/production
distinction is called out for this behavior anywhere in the docs.
Source: <https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries>

**8. Consent-screen automation is not clearly permitted or forbidden.** The current
Intuit Developer Terms of Service (no separate "Application Program License Agreement"
currently exists on developer.intuit.com — this ToS appears to be its successor), under
"3. PROHIBITED USES OF THE INTUIT DEVELOPER PLATFORM" → "Data Retrieval Activities":

> "You must not engage with, access or use the Intuit Developer Platform using any form of
> scraping, automated retrieval, botting, crawling, data mining, harvesting, indexing, or
> interfering with Intuit Developer Platform, the Services, Intuit Content, User Data or
> any other data from the Intuit Developer Platform."

This is broad enough to plausibly reach a Playwright-driven login/consent click against
`appcenter.intuit.com` (part of "the Intuit Developer Platform"), but the clause's framing
(alongside "Misuse," "Benchmarking," "Wholesale Activities") targets scraping/harvesting
abuse rather than naming test automation of one's own consent flow. Section 7 ("Sandbox and
Community Forums") only restricts sandbox use to "the creation, testing, and internal
evaluation of your Developer Applications" and says nothing about tooling. No clause names
"headless browser," "Playwright," or "bot" in the OAuth-UI context, and none carves out
permission for automating one's own consent click. **Net: ambiguous, not a clear yes or a
clear no** — a compliance judgment call, not a technical fact.
Source: <https://developer.intuit.com/app/developer/qbo/docs/legal-agreements/intuit-terms-of-service-for-intuit-developer-services> (§3.1, §7)
Source: <https://developer.intuit.com/app/developer/qbo/docs/legal-agreements> (confirms no separate license-agreement doc is currently listed)

**9. No non-interactive way to mint the first sandbox token.** The OAuth setup doc's
token-exchange parameter table requires `grant_type=authorization_code` for the initial
exchange (`refresh_token` only for subsequent refreshes) — no `client_credentials` grant,
service-account flow, or "connect to sandbox" API appears anywhere in the OAuth, Playground,
or sandbox docs. A human must complete the interactive authorization screen **at least
once** per token lineage; only *refreshing* an already-issued token needs no further human
interaction ("without prompting users for permission").
Source: <https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0>

## Direct answers to the ticket's four research questions

1. **Does sandbox support the full flow without production app review, and what
   credentials/redirect constraints apply?** Yes to the full OAuth 2.0 + Accounting API
   flow (findings 2, 7, 9 above) with no review gate. Credentials: Client ID + Client
   Secret from the app's Development tab (finding 4). `localhost` redirect URIs are
   allowed for Development/sandbox keys only (finding 3). Sandbox companies can be reset
   or recreated on demand (finding 1).
2. **Does sandbox honor `MAXRESULTS`/`STARTPOSITION` on the Invoice query, with realistic
   IDs for the zero-duplicate assertion?** Per docs, yes — identical mechanism to
   production, and Invoice is literally Intuit's own pagination example (finding 7). But
   this shipped code never issues that query (see "What the code actually does" above) —
   its zero-duplicate assertion is proven against `sync_log`'s `payloadHash`/`externalId`
   dedupe, not an Invoice re-query. The returned `Customer.Id`/`SalesReceipt.Id` values
   from a real sandbox call would be realistic, sandbox-assigned QBO ids, not fixtures.
3. **Rate limits / token lifetimes that would make a Playwright run flaky; is a recorded
   cassette a legitimate stand-in for the OAuth leg?** Rate limits are generous relative
   to a small E2E fixture (500/min, 10/sec per realm — findings 6); a handful of
   invoice/customer pushes per run is far under threshold. Token lifetimes (60 min
   access, 100-day rolling / 5-year hard refresh — finding 5) mean a single interactive
   grant, once refreshed periodically, can back many CI runs without re-consenting. A
   cassette *can* legitimately replace the machine-to-machine legs (the token-exchange
   POST and the Accounting API POSTs — which is exactly what today's rung-4 test already
   does), but it **cannot** stand in for the human's one-time click on Intuit's own hosted
   consent page, because that page is not under this repo's control and a cassette
   replaying an authorization `code` would fail against Intuit's real token endpoint (a
   `code` is single-use and short-lived) unless the token exchange were *also* mocked —
   at which point the proof is no longer "against Intuit's sandbox," just today's rung-4
   test again.
4. **Is any part of the flow intrinsically non-hermetic, e.g. can't the consent screen be
   automated under Intuit's terms?** Yes — see finding 8 (ambiguous ToS) and finding 9 (no
   non-interactive grant exists at all). The interactive consent click is the one leg that
   cannot be self-provisioned by an agent and whose automation is not clearly licensed by
   Intuit's terms.

## Exact credentials/env vars Josh would have to create (names only)

- An Intuit Developer account (free) — auto-provisions one sandbox company.
- `QUICKBOOKS_CLIENT_ID`
- `QUICKBOOKS_CLIENT_SECRET`
- `QUICKBOOKS_REDIRECT_URI` (pin explicitly for a hermetic run — e.g. a `localhost` URL —
  rather than relying on the `apiBaseUrl`-derived default; must also be registered in the
  Intuit app's Development redirect-URI list)
- `QUICKBOOKS_ENVIRONMENT` (set to `sandbox`)
- One interactive OAuth consent, completed once (and again every ≤100 days if the
  resulting refresh token isn't kept alive by periodic refreshing) using an Intuit account
  login belonging to Josh or whoever owns the developer app — this is a **human action**,
  not a credential that can be handed to an agent as a name/value pair.

## Are localhost redirect URIs permitted?

Yes, for Development/sandbox keys only (finding 3). Production keys require HTTPS with no
IP-address or localhost redirect.

## Can the consent screen be automated under Intuit's terms?

Not clearly either way (finding 8). The closest applicable clause (Developer ToS §3.1,
"Data Retrieval Activities") prohibits "automated retrieval… botting… interfering with"
the Intuit Developer Platform, worded toward scraping/harvesting abuse rather than a
developer automating their own consent click, but it is not carved out as permitted
either. Recommend treating the interactive grant as a manual, human-performed step (Josh,
periodically) rather than scripting it with Playwright against Intuit's live login form.

## Does sandbox pagination match what the row asserts?

The row's pagination clause is proven against ServiceOS's own Postgres pagination
(`invoiceRepo.findByTenant` with `limit`/`offset`), which sandbox has no bearing on — it's
already fully proven at rung 4. Intuit's own Invoice-query pagination (`MAXRESULTS`/
`STARTPOSITION`) is confirmed identical between sandbox and production (finding 7), but
this codebase does not call it; that fact would only become load-bearing if a future
change makes the sync *pull* invoices from QuickBooks instead of pushing sales receipts.

## Assertion plan for the three acceptance clauses, at rung 5

All three already have a rung-4 proof today (`accounting-sync.test.ts`, real Postgres,
mocked QuickBooks HTTP). The rung-5 versions below add reachability: driven from the
settings UI/API surface, against the real sandbox, once the OAuth grant above exists.

**1. Zero duplicate QuickBooks calls / zero new `sync_log` rows on re-sweep.**
Seed (or reuse, from the one-time grant) a connected sandbox integration through the real
`/connect` → Intuit consent → `/callback` path — not SQL. Create one paid invoice through
the product's own invoice/payment API. Trigger a sync via
`POST /api/integrations/quickbooks/sync` (or the UI's sync action) and read
`GET /api/integrations/quickbooks/status` to capture `recentSync`'s length/contents.
Trigger sync again; assert the second `POST /quickbooks/sync` response has
`pushedInvoices: 0`, and that `recentSync` gained no new entries. Optionally cross-check
against the real sandbox company by querying its `SalesReceipt` entity for the `DocNumber`
and confirming exactly one exists (via the Accounting API query endpoint, called directly
from the test harness).

**2. Pagination syncs every paid invoice.** Create N paid invoices (N small — e.g. 3–5, to
stay well clear of the 500/min-per-realm and 10/sec-per-realm+app limits, finding 6)
through the product's own API, not SQL. Trigger sync once. Assert
`GET /quickbooks/status`'s `recentSync` (or a paged read of it) shows N successful
`invoice` entries. Independently confirm against the real sandbox by querying its
`SalesReceipt` entity (`STARTPOSITION`/`MAXRESULTS`, confirmed identical to production —
finding 7) and counting N matching `DocNumber`s, proving the invoices actually landed in
QuickBooks rather than merely that ServiceOS's internal loop believes they did.

**3. `sync_log` is RLS-isolated.** This is a database property, already proven at rung 4
using a `NOBYPASSRLS` role and a raw cross-tenant query — re-deriving it via SQL in a
Playwright run would violate rung 5's "no SQL" rule, so the existing D: proof should stand
for the RLS mechanism itself. The rung-5-appropriate re-assertion is API/UI-level: seed two
tenants (each with their own connected sandbox integration), and from Tenant B's
authenticated session call `GET /api/integrations/quickbooks/status`, asserting it never
surfaces Tenant A's `recentSync` entries. This needs nothing beyond what clauses 1–2
already require.

## Independent finding, not asked for but relevant to the honest answer

`AccountingSyncService`/`runAccountingSyncSweep` iterates **every** active integration
across **all** tenants via `integrationRepo.findAllActive()` — the same "sweep" shape as
the sweeps covered in `packages/api/test/integration/sweep-tenant-fanout.test.ts` on the
PRD branch (`origin/claude/kind-hypatia-ok5dy1`), which pins T4 ("the production selector
runs, not a stubbed list; every eligible tenant is processed; a failure on one does not
abort the rest") for eight other sweeps (digest/timezone, weekly-feedback, hold-reaper,
estimate-reminder, hfcr weekly-send, google-reviews, thank-you-SMS, review-request). **The
accounting-sync sweep is not among them.** Per PRD §8.0's capping rule — "Any capability
that iterates tenants is capped at rung 4 until T4" — this row may be capped at 4
regardless of the OAuth question, until a T4-shaped test (N seeded tenants processed by
the real `findAllActive()` selector, one tenant's integration failing without aborting the
others') is added to `accounting-sync.test.ts` or `sweep-tenant-fanout.test.ts`. That gap
is pure code work, not blocked on Josh or on Intuit at all.

## Sources

- <https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes/manage-your-sandboxes>
- <https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes/sandbox-faqs>
- <https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0-playground>
- <https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0>
- <https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/set-redirect-uri>
- <https://developer.intuit.com/app/developer/qbo/docs/learn/limits-and-throttles>
- <https://web.archive.org/web/20251011070527/https://blogs.intuit.com/2025/08/13/upcoming-changes-to-the-accounting-api/> (secondary — archived; live URL now redirects off-page)
- <https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice>
- <https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries>
- <https://developer.intuit.com/app/developer/qbo/docs/legal-agreements/intuit-terms-of-service-for-intuit-developer-services>
- <https://developer.intuit.com/app/developer/qbo/docs/legal-agreements>

Repo files read (`origin/main`, ServiceOS): `packages/api/src/integrations/accounting/quickbooks-oauth.ts`,
`quickbooks-client.ts`, `sync-service.ts`, `accounting-provider.ts`, `types.ts`,
`repository.ts`; `packages/api/src/routes/integrations.ts`; `packages/api/src/app.ts`
(qboConfig wiring, 5-minute sweep interval); `packages/api/src/db/schema.ts` (migration
`172_create_accounting_integrations`); `packages/api/test/integration/accounting-sync.test.ts`;
`packages/web/src/components/integrations/QuickBooksConnect.tsx`; PRD row 9.11 and §8.0
(`docs/PRD-v5-as-built.md` on `origin/claude/kind-hypatia-ok5dy1`); `sweep-tenant-fanout.test.ts`
on the same branch.
