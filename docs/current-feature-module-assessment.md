# ServiceOS Current Feature and Module Assessment

**Assessment date:** 2026-05-04  
**Scope:** Current repository state under `/Users/macmini/Documents/Serviceos`, based on static code inspection plus local verification commands.

## Executive Summary

ServiceOS has a large amount of functional product code today. The backend domain layer, API routing, Postgres repository layer, auth gates, billing calculations, proposal lifecycle, AI gateway, voice pipeline, files, catalog, quality metrics, and dispatch board query logic are all implemented and mostly covered by automated tests.

The strongest working areas are the API production build, shared billing and typed contracts, core CRUD domains, proposal approval/execution, invoice/estimate logic, vertical packs, catalog items, file upload flow, Clerk signup bootstrap, and the React shell/pages that call the API through shared hooks.

The main caveat is that "working" is not uniform across the product. Some frontend screens are polished but still backed by mock data or nonexistent endpoints. API tests are close to green but currently fail 3 assertions. A real production deployment still depends on correct runtime configuration for Postgres, Clerk token shape, AI provider, R2, Stripe, and public/customer-facing endpoints.

## Verification Run

| Check | Result | Notes |
| --- | --- | --- |
| `cd packages/api && npx tsc --project tsconfig.build.json --noEmit` | Pass | Mandatory Railway-style production build check passed. |
| `npm run lint --workspace=packages/api` | Pass | API source-only TypeScript lint check passed. |
| `npm run test --workspace=packages/api` | Fail | 206/208 test files passed; 1961/2005 tests passed; 3 assertions failed; 41 todo. |
| `npm run lint --workspace=packages/web` | Pass | Web TypeScript check passed. |
| `npm run test --workspace=packages/web` | Pass | 76/76 test files passed; 520/520 tests passed. |
| `npm run build --workspace=packages/web` | Pass with warning | Vite build passed; bundle warning for 1.46 MB JS chunk. |
| `cd packages/shared && npm run build` | Pass | Shared package builds directly, but it is not included in root workspaces. |
| `npm run build --workspace=packages/shared` | Fail | Root workspace config excludes `packages/shared`. |

## What Is Working Today

### Platform and App Composition

**Status: Working with configuration caveats**

- `packages/api/src/app.ts` mounts the API surface behind Clerk auth and global `requireAuth`.
- The app now uses Postgres repositories when `DATABASE_URL` is present and refuses to boot in prod/staging without durable database configuration.
- Health checks, CORS, rate limiting, Swagger UI, webhook mounting, storage-dev routes, and global error conversion are wired.
- Production config validation exists in `packages/api/src/shared/config.ts`.

### Database and Persistence Layer

**Status: Mostly working**

- `packages/api/src/db/schema.ts` defines migrations for tenants, users, audit events, files, conversations, voice recordings, AI runs, document revisions, and many business tables.
- Postgres repositories exist for core domains: customers, locations, jobs, appointments, estimates, invoices, payments, notes, conversations, settings, templates, bundles, quality metrics, voice, files, job files, catalog items, proposals, feature flags, queues, webhooks, pack activation, tenant bootstrap, technician telemetry, and vertical pack registry.
- Local/dev still falls back to in-memory repositories without `DATABASE_URL`, which is useful for tests but not representative of production behavior.

### Auth, Tenant Bootstrap, and Authorization

**Status: Partially working**

- Frontend uses Clerk components for login/signup and protects app routes with `ProtectedRoute`.
- `AuthTokenBridge` wires Clerk `getToken()` into `apiFetch`, and shared query/mutation hooks attach bearer tokens.
- Clerk webhook handling now calls `bootstrapTenant()`, seeds settings when a settings repo is provided, and best-effort writes `tenant_id` back to Clerk user metadata.
- Backend route permissions and tenant guards are extensively tested.
- Caveat: backend token verification in `packages/api/src/auth/clerk.ts` is a custom HMAC decoder, not a JWKS/RS256 Clerk verification path. This may work only if the deployed Clerk token strategy matches that implementation.

### Core Business Entities

**Status: Working**

The following domains have domain logic, route modules, repository implementations, and tests:

- Customers
- Locations
- Jobs and job lifecycle timeline
- Appointments
- Notes
- Settings
- Catalog/price book items
- Files and job files
- Feature flags
- Tenant ownership checks

Frontend list/detail patterns for jobs, customers, estimates, invoices, appointments, payments, and dispatch are covered by shared hooks and component tests.

### Billing, Estimates, Invoices, and Payments

**Status: Mostly working, with payment collection gaps**

- Shared billing engine uses integer cents and has tests.
- Estimate lifecycle, numbering, revisions, edit deltas, approvals, provenance, analytics, wording preferences, bundle suggestions, and vertical context are implemented and tested.
- Invoice lifecycle, status transitions, payment recording, proposal validation, payment readiness, and Stripe webhook parsing/reconciliation logic are implemented and tested.
- API payment routes support authenticated manual payment recording and listing by invoice.
- Stripe payment link provider exists.
- Caveats:
  - API tests currently fail one due-date assertion in `packages/api/test/invoices/invoice.test.ts`.
  - Public customer invoice payment UI calls `/api/payments/public/collect`, but the API only mounts authenticated `/api/payments` routes.
  - `InvoicePaymentPage` imports mock invoice/customer data for display.

### Proposal Engine and Human Approval Flow

**Status: Working**

- Proposal contracts, lifecycle, audit events, prioritization, rejection, route handling, and approval/reject/undo paths are implemented.
- Execution handlers exist for appointment creation, reassignment, reschedule, cancellation, estimate updates, invoice updates, invoice issue/send flows, and voice-extended actions.
- Auto-delivery sweep runs on an interval after the undo window.
- Tests cover contracts, route behavior, idempotency, execution, and tenant isolation.

### AI Gateway and Assistant

**Status: Partially working**

- LLM gateway supports provider routing, failover, caching, health checks, complexity classification, and shadow comparison.
- `/api/assistant/chat` is mounted, validates typed messages, routes recognized `create_customer` intent into a real proposal, and falls back to generic LLM JSON response.
- Frontend `AssistantPage` calls `/api/assistant/chat` through `apiFetch`.
- Caveats:
  - Without `AI_PROVIDER_API_KEY`, the app uses a mock/fallback gateway.
  - Many assistant capabilities remain generic LLM replies rather than domain-specific proposal creation.
  - Some dispatcher/customer flows use plain `fetch()` instead of `apiFetch()`, so protected API calls may lack auth headers.

### Voice and Transcription

**Status: Partially working**

- API supports creating voice recording records, queueing transcription jobs, polling recording status, and retrying transcription.
- Transcription worker enqueues the downstream voice-action-router job after successful transcription.
- `OpenAiWhisperProvider` exists and uses Whisper when `AI_PROVIDER_API_KEY` is configured.
- Frontend `VoiceBar` and assistant voice flow upload files, verify upload, create recordings, and poll for completion.
- Caveats:
  - Without `AI_PROVIDER_API_KEY`, transcription uses `DevNoopTranscriptionProvider`.
  - `OnboardingPage` calls `/api/voice/transcribe`, but the API exposes `/api/voice/recordings`, not `/api/voice/transcribe`.

### Dispatch and Scheduling

**Status: Partial**

- Backend dispatch board query, lateness logic, analytics, validation, and proposal execution handlers are implemented.
- Frontend `DispatchBoard` loads `/api/dispatch/board` and renders day-scoped technician lanes and unassigned queue.
- Drag/drop utility and create-schedule-proposal hook are implemented and tested.
- Caveats:
  - `DispatchBoard` does not currently wire `useDragDrop()` or `useCreateScheduleProposal()` into the rendered lanes/queue.
  - API dispatch validation tests currently fail 2 working-hours assertions.
  - `TechnicianDayView` calls `/api/dispatch/delay-prompt-audits` and `/api/dispatch/delay-escalations`, but those endpoints are not mounted in `createDispatchRoutes()`.

### Files, Storage, and Catalog

**Status: Working with provider configuration**

- File upload flow supports signed upload requests, verification, metadata, job attachments, and dev storage.
- R2-compatible storage provider is present.
- Price book UI uses `/api/catalog/items` for list/create/update/delete and includes CSV import validation.
- Catalog API routes and repositories are implemented.

### Vertical Packs, Templates, and Quality

**Status: Working**

- HVAC and plumbing vertical packs, categories, terminology, bundles, missing item signals, wording preferences, and context assembly are implemented.
- Estimate templates and service bundles have API routes and repository layers.
- Quality metrics and approval/delta-backed quality routes are implemented and tested.

### Web Application Shell and Common UI

**Status: Mostly working**

- React Router config covers auth routes, onboarding, public/customer-facing flows, and protected app pages.
- Web tests pass across common components, hooks, routes, job/customer/estimate/invoice pages, dispatch components, voice components, status components, and settings components.
- Shared hooks `useListQuery`, `useDetailQuery`, and `useMutation` use authenticated `apiFetch`.
- Caveats:
  - Build emits a large chunk warning.
  - Tests show React warnings for nested buttons, unwrapped state updates, and chart zero-size rendering in test environment.

## Feature Areas That Are Present But Not Fully Working End-to-End

| Area | Current State | Blocking Gap |
| --- | --- | --- |
| Public invoice payment | UI exists and tests pass | API endpoint `/api/payments/public/collect` is missing; UI uses mock invoice/customer data. |
| Public estimate approval | UI exists with signature flow | UI imports mock estimate/customer data and uses timeout confirmation. |
| Public feedback | UI calls `/public/feedback/:token` | No matching API route found. |
| Feedback dashboard | UI calls `/api/feedback/responses` | No matching API route found. |
| Maintenance contracts | UI routes/components call `/api/maintenance-contracts` and customer nested contracts | No matching API route found. |
| Dispatch drag/drop proposals | Hook exists and is tested | `DispatchBoard` does not wire drag/drop into rendered components. |
| Delay prompt audit/escalation | Technician UI calls endpoints | Backend dispatch route only exposes `/api/dispatch/board`. |
| Onboarding voice transcription | UI calls `/api/voice/transcribe` | Backend exposes recording-based voice ingestion instead. |
| Settings sections | Main settings page renders many sections | Several actions are still empty handlers; price book and review URL save are real. |
| Shared package workspace | Package builds directly | Root workspaces exclude `packages/shared`, so normal workspace commands skip it. |

## Current Test Failures

### API dispatch validation

`packages/api/test/dispatch/validation.test.ts` fails:

- `detects appointment outside working hours`
- `no conflict when within working hours`

The implementation now interprets appointment hour/minute in a supplied timezone defaulting to UTC. The tests create dates without a `Z`, so they are local-time dates in `America/Phoenix`, then interpreted through UTC by the implementation. That flips the expected result.

### API invoice due date

`packages/api/test/invoices/invoice.test.ts` fails:

- `happy path — calculates due date correctly`

The test uses `new Date('2026-01-15')`, which is parsed as UTC midnight. In `America/Phoenix`, local date accessors see January 14, so the local `setDate/getDate` path returns February 13 instead of the test's expected February 14. This is a timezone-sensitive behavior and should be fixed with explicit UTC or date-only semantics.

## Practical Working Classification

### Green: Usable or close to usable behind proper env configuration

- API production build
- Web production build
- Clerk frontend route protection
- Settings bootstrap from Clerk webhook
- Core CRUD API for customers, locations, jobs, appointments, estimates, invoices, payments, notes
- Catalog/price book
- Files and job files
- Billing engine
- Estimate and invoice domain logic
- Proposal lifecycle and execution
- AI gateway infrastructure
- Voice recording ingestion pipeline
- Vertical packs/templates/quality metrics
- Feature flags
- Health checks, logging, config validation

### Yellow: Implemented but not fully product-complete

- Assistant chat
- Voice transcription
- Dispatch board
- Schedule page
- Technician day view
- Settings
- Payments and Stripe links
- Public/customer-facing estimate approval and invoice payment
- Feedback and review flows
- Maintenance contracts

### Red: Not working end-to-end today

- API unit test suite as a release gate because 3 assertions fail.
- Public invoice payment collection.
- Public feedback API.
- Maintenance contract API.
- Dispatch delay prompt audit/escalation endpoints.
- Onboarding direct voice transcription endpoint.
- Root workspace coverage for `packages/shared`.

## Recommended Next Verification Pass

1. Fix the 3 API test failures so API tests are green.
2. Add route-existence tests for every frontend hardcoded API path.
3. Decide whether public flows are API-backed or intentionally mock/demo; remove mock imports from production routes if they should be live.
4. Wire `packages/shared` into the root workspaces or remove it from the active product surface.
5. Run a database-backed smoke test with `DATABASE_URL` set to validate Pg repositories and RLS behavior outside in-memory tests.
