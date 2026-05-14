# Intake Form Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish §4's public intake form — add test coverage, replace hardcoded mock branding with real tenant data from a new public API endpoint, and drive the service-type list from the tenant's active vertical packs.

**Architecture:** The intake form page (`IntakeFormPage.tsx`) already exists, is routed at `/intake`, and posts leads to `POST /public/intake/:tenantId/leads`. This plan (1) adds a new read-only `GET /public/intake/:tenantId` endpoint returning `{ businessName, businessPhone, serviceTypes }`, (2) extracts a typed web API client for both intake endpoints so the component is testable, (3) adds characterization tests for the existing wizard, then (4) wires the component to load real tenant branding and pack-driven service types, dropping the hardcoded "Ortega HVAC & Services / 4.9 · 124 reviews / HVAC·Plumbing·Painting" mock data.

**Tech Stack:** TypeScript. API: Express + Zod + vitest + supertest. Web: React + React Router v7 + Tailwind v4 + vitest + @testing-library/react.

---

## Context the executing engineer needs

**The existing endpoint** is `packages/api/src/routes/public-intake.ts`, exporting `createPublicIntakeRouter(leadRepo, tenantRepo, auditRepo)`. It mounts a `POST /:tenantId/leads` handler. Key shared pieces in that file, reused by the new GET handler:
- `const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;`
- `import { toErrorResponse } from '../shared/errors';`
- Error response shapes already used: `400 { error: 'VALIDATION_ERROR', message }`, `404 { error: 'NOT_FOUND', message }`.

**The models:**
- `Tenant` (`packages/api/src/auth/clerk.ts`): `{ id, ownerId, ownerEmail, name, createdAt }`. `name` is a legacy org name, not the public business name.
- `TenantSettings` (`packages/api/src/settings/settings.ts`): has `businessName: string`, `businessPhone?: string | null`, `activeVerticalPacks?: string[]` (array of `packId` strings like `'hvac-v1'`). `SettingsRepository.findByTenant(tenantId)` returns `TenantSettings | null`.
- `VerticalPack` (`packages/api/src/shared/vertical-pack-registry.ts`): `{ id, packId, version, verticalType: 'hvac' | 'plumbing', status: 'draft' | 'active' | 'deprecated', displayName, description?, metadata?, createdAt, updatedAt }`. `VerticalPackRegistry.getByPackId(packId)` returns `VerticalPack | null`.

**In-memory test repositories:** `DevInMemoryTenantRepository` (`packages/api/src/auth/dev-auth-bypass.ts`), `InMemorySettingsRepository` (`packages/api/src/settings/settings.ts`), `InMemoryVerticalPackRegistry` (`packages/api/src/shared/vertical-pack-registry.ts`).

**Commands:**
- API single test: from `packages/api`, `npm test -- test/routes/public-intake.route.test.ts`
- API production typecheck: from repo root, `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
- Web single test: from `packages/web`, `npm test -- <filename>`
- Web typecheck: from `packages/web`, `npm run lint` (runs `tsc --noEmit`)

---

## File Structure

**Created:**
- `packages/web/src/api/public-intake.ts` — typed, unauthenticated client for the two public intake endpoints (`fetchIntakeTenantInfo`, `submitIntakeLead`). One responsibility: wrap the wire calls and own the request/response types.
- `packages/web/src/api/public-intake.test.ts` — unit tests for that client.
- `packages/web/src/components/customer/IntakeFormPage.test.tsx` — component tests for the wizard.

**Modified:**
- `packages/api/src/routes/public-intake.ts` — widen `createPublicIntakeRouter` to accept `settingsRepo` + `packRegistry`; add the `GET /:tenantId` handler.
- `packages/api/test/routes/public-intake.route.test.ts` — update setup for the new signature; add a `GET` describe block.
- `packages/api/src/app.ts` — pass `settingsRepo` and `canonicalPackRegistry` into `createPublicIntakeRouter`.
- `packages/web/src/components/customer/IntakeFormPage.tsx` — use the API client; load real tenant branding; drive service types from packs; drop hardcoded mock data; add `data-testid` hooks.

---

## Task 1: Backend — `GET /public/intake/:tenantId` endpoint

**Files:**
- Modify: `packages/api/src/routes/public-intake.ts`
- Test: `packages/api/test/routes/public-intake.route.test.ts`

- [ ] **Step 1: Create the working branch**

```bash
git checkout -b feat/intake-form-completion
```

- [ ] **Step 2: Replace the test file's setup block with the new-signature version and add GET tests**

In `packages/api/test/routes/public-intake.route.test.ts`, replace the import block + `describe` header + `beforeEach` (the existing setup that constructs `createPublicIntakeRouter` with 3 args) with this exact block. Leave every existing `POST` test below it untouched.

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { createPublicIntakeRouter } from '../../src/routes/public-intake';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { DevInMemoryTenantRepository } from '../../src/auth/dev-auth-bypass';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryVerticalPackRegistry } from '../../src/shared/vertical-pack-registry';

describe('public-intake route', () => {
  let app: Express;
  let leadRepo: InMemoryLeadRepository;
  let auditRepo: InMemoryAuditRepository;
  let tenantRepo: DevInMemoryTenantRepository;
  let settingsRepo: InMemorySettingsRepository;
  let packRegistry: InMemoryVerticalPackRegistry;
  let tenantId: string;

  beforeEach(async () => {
    leadRepo = new InMemoryLeadRepository();
    auditRepo = new InMemoryAuditRepository();
    tenantRepo = new DevInMemoryTenantRepository();
    settingsRepo = new InMemorySettingsRepository();
    packRegistry = new InMemoryVerticalPackRegistry();
    const tenant = await tenantRepo.create({
      ownerId: 'owner-1',
      ownerEmail: 'owner@example.com',
      name: 'Test Co',
    });
    tenantId = tenant.id;

    app = express();
    app.use(express.json());
    app.use(
      '/public/intake',
      rateLimit({
        windowMs: 60_000,
        max: 1000,
        standardHeaders: false,
        legacyHeaders: false,
      }),
      createPublicIntakeRouter(leadRepo, tenantRepo, auditRepo, settingsRepo, packRegistry),
    );
  });
```

> Note: `max` is raised to `1000` so the added GET tests don't trip the rate limiter alongside the existing POST tests. If the existing block already used a high `max`, keep whichever is higher.

Then append this new `describe` block at the end of the file, immediately before the final closing `});` of the top-level `describe('public-intake route', ...)`:

```typescript
  describe('GET /public/intake/:tenantId', () => {
    it('returns business info and pack-derived service types for a configured tenant', async () => {
      await settingsRepo.create({
        id: 'settings-1',
        tenantId,
        businessName: 'Ortega HVAC & Services',
        businessPhone: '(512) 555-0100',
        timezone: 'America/Chicago',
        estimatePrefix: 'EST-',
        invoicePrefix: 'INV-',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        activeVerticalPacks: ['hvac-v1'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await packRegistry.register({
        id: 'pack-hvac-1',
        packId: 'hvac-v1',
        version: '1.0.0',
        verticalType: 'hvac',
        status: 'active',
        displayName: 'HVAC Services',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await request(app).get(`/public/intake/${tenantId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        businessName: 'Ortega HVAC & Services',
        businessPhone: '(512) 555-0100',
        serviceTypes: [{ verticalType: 'hvac', displayName: 'HVAC Services' }],
      });
    });

    it('falls back to the tenant name and empty service types when settings are absent', async () => {
      const res = await request(app).get(`/public/intake/${tenantId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        businessName: 'Test Co',
        businessPhone: null,
        serviceTypes: [],
      });
    });

    it('returns 404 for an unknown tenant', async () => {
      const res = await request(app).get(
        '/public/intake/99999999-9999-4999-8999-999999999999',
      );
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Intake form not found' });
    });

    it('returns 400 for a malformed tenant id', async () => {
      const res = await request(app).get('/public/intake/not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
    });
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/api && npm test -- test/routes/public-intake.route.test.ts`
Expected: FAIL — TypeScript errors (`createPublicIntakeRouter` expects 3 args, got 5) and/or the new GET tests 404 because no GET route exists.

- [ ] **Step 4: Widen the router signature and add the GET handler**

In `packages/api/src/routes/public-intake.ts`:

Add these imports alongside the existing imports at the top of the file:

```typescript
import { SettingsRepository } from '../settings/settings';
import { VerticalPackRegistry } from '../shared/vertical-pack-registry';
```

Replace the `createPublicIntakeRouter` function signature:

```typescript
export function createPublicIntakeRouter(
  leadRepo: LeadRepository,
  tenantRepo: TenantRepository,
  auditRepo: AuditRepository,
  settingsRepo: SettingsRepository,
  packRegistry: VerticalPackRegistry,
): Router {
```

Then, inside that function, immediately before the final `return router;`, add the GET handler:

```typescript
  // Public tenant info for the intake form header + service-type list.
  // Read-only; same UUID-in-path validation and rate limiting as the POST.
  router.get('/:tenantId', async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.tenantId;
      if (!TENANT_UUID.test(tenantId)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
        return;
      }

      const tenant = await tenantRepo.findById(tenantId);
      if (!tenant) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Intake form not found' });
        return;
      }

      const settings = await settingsRepo.findByTenant(tenantId);

      const serviceTypes: { verticalType: string; displayName: string }[] = [];
      for (const packId of settings?.activeVerticalPacks ?? []) {
        const pack = await packRegistry.getByPackId(packId);
        if (pack) {
          serviceTypes.push({
            verticalType: pack.verticalType,
            displayName: pack.displayName,
          });
        }
      }

      res.status(200).json({
        businessName: settings?.businessName ?? tenant.name,
        businessPhone: settings?.businessPhone ?? null,
        serviceTypes,
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npm test -- test/routes/public-intake.route.test.ts`
Expected: PASS — all existing POST tests plus the four new GET tests.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/public-intake.ts packages/api/test/routes/public-intake.route.test.ts
git commit -m "feat(api): add GET /public/intake/:tenantId for public form branding"
```

---

## Task 2: Backend — wire the new dependencies in `app.ts`

**Files:**
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Pass the settings repo and pack registry into the router**

In `packages/api/src/app.ts`, find the `/public/intake` mount (around line 1245-1254). Replace this line:

```typescript
    createPublicIntakeRouter(leadRepo, intakeTenantRepo, auditRepo)
```

with:

```typescript
    createPublicIntakeRouter(leadRepo, intakeTenantRepo, auditRepo, settingsRepo, canonicalPackRegistry)
```

`settingsRepo` and `canonicalPackRegistry` are already constructed earlier in the same function scope (`settingsRepo` ~line 699, `canonicalPackRegistry` ~line 769) — no new imports or variables are needed.

- [ ] **Step 2: Run the production typecheck to verify it passes**

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — no output, exit code 0. This is the same tsconfig the Railway deploy uses.

- [ ] **Step 3: Run the full API test file again to confirm nothing regressed**

Run: `cd packages/api && npm test -- test/routes/public-intake.route.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/app.ts
git commit -m "feat(api): wire settings + vertical-pack deps into public intake router"
```

---

## Task 3: Web — typed public intake API client

**Files:**
- Create: `packages/web/src/api/public-intake.ts`
- Test: `packages/web/src/api/public-intake.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/api/public-intake.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchIntakeTenantInfo, submitIntakeLead } from './public-intake';

describe('public-intake api client', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('fetchIntakeTenantInfo', () => {
    it('GETs the tenant info endpoint and returns the parsed body', async () => {
      const body = {
        businessName: 'Ortega HVAC & Services',
        businessPhone: '(512) 555-0100',
        serviceTypes: [{ verticalType: 'hvac', displayName: 'HVAC Services' }],
      };
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await fetchIntakeTenantInfo('tenant-123');

      expect(fetchMock).toHaveBeenCalledWith(
        '/public/intake/tenant-123',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result).toEqual(body);
    });

    it('throws when the response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      await expect(fetchIntakeTenantInfo('missing')).rejects.toThrow(
        'Could not load intake form (404)',
      );
    });
  });

  describe('submitIntakeLead', () => {
    it('POSTs the payload as JSON and returns the parsed body', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ ok: true, leadId: 'lead-1' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const payload = {
        firstName: 'Sandra',
        primaryPhone: '5125550191',
        _company_url: '',
      };
      const result = await submitIntakeLead('tenant-123', payload);

      expect(fetchMock).toHaveBeenCalledWith(
        '/public/intake/tenant-123/leads',
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
      expect(result).toEqual({ ok: true, leadId: 'lead-1' });
    });

    it('throws when the response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      await expect(
        submitIntakeLead('tenant-123', { firstName: 'X', _company_url: '' }),
      ).rejects.toThrow('Submission failed (500)');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/web && npm test -- public-intake.test.ts`
Expected: FAIL — `Failed to resolve import "./public-intake"` (the module does not exist yet).

- [ ] **Step 3: Write the API client**

Create `packages/web/src/api/public-intake.ts`:

```typescript
/**
 * Public intake API client — UNAUTHENTICATED.
 *
 * The /intake page is a public, shareable marketing link; there is no
 * Clerk session. These calls use plain `fetch`, not `apiFetch`. The
 * tenant id comes from the `?t=<uuid>` query param on the landing URL
 * (resolved by the caller, not this module).
 */

export interface IntakeServiceType {
  verticalType: string;
  displayName: string;
}

export interface IntakeTenantInfo {
  businessName: string;
  businessPhone: string | null;
  serviceTypes: IntakeServiceType[];
}

export interface SubmitIntakeLeadPayload {
  firstName: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
  serviceType?: string;
  urgency?: string;
  description?: string;
  preferredDates?: string;
  address?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  attribution?: Record<string, string>;
  /** Honeypot — always sent empty; bots that fill every field trip it. */
  _company_url: string;
}

/** Load the tenant's public-facing branding + service types for the intake form. */
export async function fetchIntakeTenantInfo(tenantId: string): Promise<IntakeTenantInfo> {
  const res = await fetch(`/public/intake/${encodeURIComponent(tenantId)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Could not load intake form (${res.status})`);
  }
  return (await res.json()) as IntakeTenantInfo;
}

/** Submit a public intake lead. Resolves with the created lead id on success. */
export async function submitIntakeLead(
  tenantId: string,
  payload: SubmitIntakeLeadPayload,
): Promise<{ ok?: boolean; leadId?: string }> {
  const res = await fetch(`/public/intake/${encodeURIComponent(tenantId)}/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Submission failed (${res.status})`);
  }
  return (await res.json()) as { ok?: boolean; leadId?: string };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/web && npm test -- public-intake.test.ts`
Expected: PASS — all four tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/public-intake.ts packages/web/src/api/public-intake.test.ts
git commit -m "feat(web): add typed public intake API client"
```

---

## Task 4: Web — make `IntakeFormPage` testable + characterization tests

This task adds `data-testid` hooks, switches the submit path to the new API client (a behavior-preserving refactor), and adds characterization tests that lock the existing wizard behavior before later tasks change the branding and service-type logic.

**Files:**
- Modify: `packages/web/src/components/customer/IntakeFormPage.tsx`
- Test: `packages/web/src/components/customer/IntakeFormPage.test.tsx`

- [ ] **Step 1: Add `data-testid` hooks to `IntakeFormPage.tsx`**

Make these four edits in `packages/web/src/components/customer/IntakeFormPage.tsx`:

1. The service-option `<button>` in Step 1 — add `data-testid`:

```tsx
                  <button
                    key={opt.type}
                    data-testid={`intake-service-${opt.type}`}
                    onClick={() => update({ serviceType: opt.type })}
```

2. The description `<textarea>` in Step 2 — add `data-testid="intake-description"`:

```tsx
              <textarea
                data-testid="intake-description"
                value={data.description}
                onChange={e => update({ description: e.target.value })}
```

3. The contact `<input>` in Step 3 (inside the `.map`) — add `data-testid`:

```tsx
                <input
                  data-testid={`intake-field-${key}`}
                  value={data[key as keyof FormData] as string}
                  onChange={e => update({ [key]: e.target.value })}
```

4. The CTA `<button>` near the bottom — add `data-testid="intake-cta"`:

```tsx
            <button
              data-testid="intake-cta"
              onClick={next}
              disabled={!canAdvance || submitting}
```

- [ ] **Step 2: Switch the submit path to the API client**

In `packages/web/src/components/customer/IntakeFormPage.tsx`, add this import below the existing `lucide-react` import:

```typescript
import { submitIntakeLead } from '../../api/public-intake';
```

Then replace the body of the `submit()` function. The current version builds a payload and calls `fetch(...)` inline; replace the `const res = await fetch(...)` call and its `if (!res.ok)` check with a call to `submitIntakeLead`. The full updated function:

```typescript
  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Tenant id comes from `?t=<uuid>` on the marketing landing page.
      // Public intake doesn't have a logged-in user to derive it from.
      const tenantId =
        new URLSearchParams(window.location.search).get('t') ?? '';
      if (!tenantId) {
        throw new Error('This intake form is missing its tenant id.');
      }
      const [firstName, ...rest] = data.name.trim().split(/\s+/);
      const lastName = rest.join(' ') || undefined;
      const description = [
        data.serviceType ? `Service: ${data.serviceType}` : null,
        data.urgency ? `Urgency: ${data.urgency}` : null,
        data.description || null,
      ].filter(Boolean).join(' — ');

      await submitIntakeLead(tenantId, {
        firstName,
        lastName,
        primaryPhone: data.phone || undefined,
        email: data.email || undefined,
        serviceType: data.serviceType ?? undefined,
        urgency: data.urgency ?? undefined,
        description: description || undefined,
        preferredDates: data.preferredDates || undefined,
        address: data.address || undefined,
        utmSource: attributionRef.current.utmSource,
        utmMedium: attributionRef.current.utmMedium,
        utmCampaign: attributionRef.current.utmCampaign,
        attribution: attributionRef.current.attribution,
        // Honeypot — never set by the form, here so a bot that walks
        // the DOM and fills every input still trips it.
        _company_url: '',
      });
      setStep('done');
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : 'Something went wrong. Please try calling us instead.'
      );
    } finally {
      setSubmitting(false);
    }
  }
```

- [ ] **Step 3: Write the characterization tests**

Create `packages/web/src/components/customer/IntakeFormPage.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../api/public-intake', () => ({
  submitIntakeLead: vi.fn(),
}));

import { submitIntakeLead } from '../../api/public-intake';
import { IntakeFormPage } from './IntakeFormPage';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function setTenantQueryParam(t: string | null): void {
  window.history.pushState({}, '', t ? `/intake?t=${t}` : '/intake');
}

/** Drive the wizard from step 1 through to a submitted state. */
async function completeWizard(): Promise<void> {
  // Step 1 — pick a service.
  fireEvent.click(screen.getByTestId('intake-service-HVAC'));
  fireEvent.click(screen.getByTestId('intake-cta'));
  // Step 2 — description (>= 10 chars) + urgency.
  fireEvent.change(screen.getByTestId('intake-description'), {
    target: { value: 'AC stopped blowing cold air yesterday.' },
  });
  fireEvent.click(screen.getByText('🚨 Emergency'));
  fireEvent.click(screen.getByTestId('intake-cta'));
  // Step 3 — name + phone.
  fireEvent.change(screen.getByTestId('intake-field-name'), {
    target: { value: 'Sandra Wu' },
  });
  fireEvent.change(screen.getByTestId('intake-field-phone'), {
    target: { value: '(512) 555-0191' },
  });
  fireEvent.click(screen.getByTestId('intake-cta'));
  // Step 4 — review, then submit.
  fireEvent.click(screen.getByTestId('intake-cta'));
}

describe('IntakeFormPage', () => {
  beforeEach(() => {
    vi.mocked(submitIntakeLead).mockReset();
    vi.mocked(submitIntakeLead).mockResolvedValue({ ok: true, leadId: 'lead-1' });
    setTenantQueryParam(TENANT_ID);
  });

  it('renders step 1 with the service question', () => {
    render(<IntakeFormPage />);
    expect(screen.getByText('What can we help you with?')).toBeInTheDocument();
  });

  it('keeps the CTA disabled until a service is selected', () => {
    render(<IntakeFormPage />);
    expect(screen.getByTestId('intake-cta')).toBeDisabled();
    fireEvent.click(screen.getByTestId('intake-service-HVAC'));
    expect(screen.getByTestId('intake-cta')).not.toBeDisabled();
  });

  it('submits the lead with a split name, honeypot, and attribution, then shows success', async () => {
    render(<IntakeFormPage />);
    await completeWizard();

    await waitFor(() => {
      expect(screen.getByText('Request submitted!')).toBeInTheDocument();
    });
    expect(submitIntakeLead).toHaveBeenCalledTimes(1);
    const [calledTenantId, payload] = vi.mocked(submitIntakeLead).mock.calls[0];
    expect(calledTenantId).toBe(TENANT_ID);
    expect(payload.firstName).toBe('Sandra');
    expect(payload.lastName).toBe('Wu');
    expect(payload.primaryPhone).toBe('(512) 555-0191');
    expect(payload._company_url).toBe('');
    expect(payload.attribution).toBeDefined();
  });

  it('shows an error and stays on the review step when submission fails', async () => {
    vi.mocked(submitIntakeLead).mockRejectedValue(new Error('Submission failed (500)'));
    render(<IntakeFormPage />);
    await completeWizard();

    await waitFor(() => {
      expect(screen.getByText('Submission failed (500)')).toBeInTheDocument();
    });
    expect(screen.queryByText('Request submitted!')).not.toBeInTheDocument();
  });

  it('shows a tenant-id error when the ?t= param is missing', async () => {
    setTenantQueryParam(null);
    render(<IntakeFormPage />);
    await completeWizard();

    await waitFor(() => {
      expect(
        screen.getByText('This intake form is missing its tenant id.'),
      ).toBeInTheDocument();
    });
    expect(submitIntakeLead).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/web && npm test -- IntakeFormPage.test.tsx`
Expected: PASS — all five tests. (If Step 2's refactor was skipped, the submit/honeypot test fails because `submitIntakeLead` is never called — that failure is the RED signal that the refactor is required.)

- [ ] **Step 5: Run the web typecheck**

Run: `cd packages/web && npm run lint`
Expected: PASS — no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/customer/IntakeFormPage.tsx packages/web/src/components/customer/IntakeFormPage.test.tsx
git commit -m "test(web): add IntakeFormPage characterization tests; use API client for submit"
```

---

## Task 5: Web — load real tenant branding, drop mock reviews

**Files:**
- Modify: `packages/web/src/components/customer/IntakeFormPage.tsx`
- Modify: `packages/web/src/components/customer/IntakeFormPage.test.tsx`

- [ ] **Step 1: Update the test mock and add branding tests (RED)**

In `packages/web/src/components/customer/IntakeFormPage.test.tsx`, update the `vi.mock` factory and the imports to include `fetchIntakeTenantInfo`:

```tsx
vi.mock('../../api/public-intake', () => ({
  submitIntakeLead: vi.fn(),
  fetchIntakeTenantInfo: vi.fn(),
}));

import { submitIntakeLead, fetchIntakeTenantInfo } from '../../api/public-intake';
```

Add a shared fixture constant just below the `TENANT_ID` constant:

```tsx
const TENANT_INFO = {
  businessName: 'Ortega HVAC & Services',
  businessPhone: '(512) 555-0100',
  serviceTypes: [{ verticalType: 'hvac', displayName: 'HVAC Services' }],
};
```

In `beforeEach`, add a default resolved value for the new mock (so every existing test still renders cleanly now that the component fetches on mount):

```tsx
    vi.mocked(fetchIntakeTenantInfo).mockReset();
    vi.mocked(fetchIntakeTenantInfo).mockResolvedValue(TENANT_INFO);
```

Add these two tests inside the `describe('IntakeFormPage', ...)` block:

```tsx
  it('loads and renders the real business name in the header', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByText('Ortega HVAC & Services')).toBeInTheDocument();
    });
    expect(fetchIntakeTenantInfo).toHaveBeenCalledWith(TENANT_ID);
  });

  it('does not render the hardcoded mock review rating', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByText('Ortega HVAC & Services')).toBeInTheDocument();
    });
    expect(screen.queryByText(/124 reviews/i)).not.toBeInTheDocument();
  });
```

Run: `cd packages/web && npm test -- IntakeFormPage.test.tsx`
Expected: FAIL — `fetchIntakeTenantInfo` is never called (component doesn't load tenant info yet) and `/124 reviews/` mock text is still present.

- [ ] **Step 2: Add tenant-info state and a load-on-mount effect**

In `packages/web/src/components/customer/IntakeFormPage.tsx`, update the API-client import to also pull the fetch function and its type:

```typescript
import { submitIntakeLead, fetchIntakeTenantInfo, type IntakeTenantInfo } from '../../api/public-intake';
```

Add a `tenantInfo` state field next to the existing `useState` declarations in the component:

```typescript
  const [tenantInfo, setTenantInfo] = useState<IntakeTenantInfo | null>(null);
```

Add a second `useEffect` immediately below the existing attribution `useEffect`:

```typescript
  // Load the tenant's public branding + service types. Non-fatal on
  // failure — the form still submits; only the header/branding degrades.
  useEffect(() => {
    const tenantId = new URLSearchParams(window.location.search).get('t');
    if (!tenantId) return;
    fetchIntakeTenantInfo(tenantId)
      .then(setTenantInfo)
      .catch(() => {
        /* branding is best-effort; submit path still reports a hard error */
      });
  }, []);
```

- [ ] **Step 3: Replace the hardcoded business header**

In `packages/web/src/components/customer/IntakeFormPage.tsx`, find the business-header block (the `<div>` containing `<p className="text-slate-900">Ortega HVAC &amp; Services</p>` and the 5-star `4.9 · 124 reviews · Austin, TX` rating). Replace the inner `<div>` — everything between `<div className="flex size-9 ...">...</div>` and the end of the header — with:

```tsx
        <div>
          <p className="text-slate-900">{tenantInfo?.businessName ?? 'Service Request'}</p>
          <p className="text-xs text-slate-400 mt-0.5">Request service online</p>
        </div>
```

This removes the hardcoded business name and the entire fake star-rating row. The `Zap` icon block to its left stays unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/web && npm test -- IntakeFormPage.test.tsx`
Expected: PASS — all seven tests.

- [ ] **Step 5: Run the web typecheck**

Run: `cd packages/web && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/customer/IntakeFormPage.tsx packages/web/src/components/customer/IntakeFormPage.test.tsx
git commit -m "feat(web): load real tenant branding on the intake form, drop mock reviews"
```

---

## Task 6: Web — drive service types from the tenant's vertical packs

**Files:**
- Modify: `packages/web/src/components/customer/IntakeFormPage.tsx`
- Modify: `packages/web/src/components/customer/IntakeFormPage.test.tsx`

- [ ] **Step 1: Update the tests for pack-driven service types (RED)**

In `packages/web/src/components/customer/IntakeFormPage.test.tsx`:

Update the `completeWizard` helper's first two lines — the service is now selected by `verticalType`, not the old `'HVAC'` label:

```tsx
  // Step 1 — pick a service.
  fireEvent.click(screen.getByTestId('intake-service-hvac'));
  fireEvent.click(screen.getByTestId('intake-cta'));
```

Update the existing `'keeps the CTA disabled until a service is selected'` test the same way:

```tsx
  it('keeps the CTA disabled until a service is selected', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByTestId('intake-service-hvac')).toBeInTheDocument();
    });
    expect(screen.getByTestId('intake-cta')).toBeDisabled();
    fireEvent.click(screen.getByTestId('intake-service-hvac'));
    expect(screen.getByTestId('intake-cta')).not.toBeDisabled();
  });
```

Add a new test inside the `describe` block:

```tsx
  it('renders only the service types returned by the tenant info endpoint', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByText('HVAC Services')).toBeInTheDocument();
    });
    // The old hardcoded "Painting" option must be gone.
    expect(screen.queryByText('Painting')).not.toBeInTheDocument();
    expect(screen.queryByTestId('intake-service-plumbing')).not.toBeInTheDocument();
  });

  it('sends the selected service display name in the submit payload', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByTestId('intake-service-hvac')).toBeInTheDocument();
    });
    await completeWizard();
    await waitFor(() => {
      expect(screen.getByText('Request submitted!')).toBeInTheDocument();
    });
    const [, payload] = vi.mocked(submitIntakeLead).mock.calls[0];
    expect(payload.serviceType).toBe('HVAC Services');
  });
```

Run: `cd packages/web && npm test -- IntakeFormPage.test.tsx`
Expected: FAIL — `intake-service-hvac` test id does not exist yet (the component still renders `intake-service-HVAC` from the hardcoded list).

- [ ] **Step 2: Replace the hardcoded service list with a presentation map**

In `packages/web/src/components/customer/IntakeFormPage.tsx`, replace the `type ServiceType` declaration and the `SERVICE_OPTIONS` constant with:

```typescript
type VerticalType = 'hvac' | 'plumbing';

interface ServicePresentation {
  emoji: string;
  desc: string;
  placeholder: string;
}

// Presentation only — emoji + copy keyed by the backend's verticalType.
// The list of services a tenant actually offers comes from the API.
const SERVICE_PRESENTATION: Record<VerticalType, ServicePresentation> = {
  hvac: {
    emoji: '❄️',
    desc: 'AC, furnace, heat pumps, ventilation',
    placeholder: `e.g. "My AC stopped blowing cold air yesterday. It's making a clicking noise."`,
  },
  plumbing: {
    emoji: '🔧',
    desc: 'Leaks, drains, water heaters, pipes',
    placeholder: `e.g. "Kitchen sink is draining very slowly and there's a bad smell."`,
  },
};

const FALLBACK_PLACEHOLDER = 'e.g. "Briefly describe what you need help with."';
```

Update the `FormData` interface — `serviceType` is now a `VerticalType`:

```typescript
interface FormData {
  serviceType: VerticalType | null;
  description: string;
  urgency: Urgency | null;
  preferredDates: string;
  name: string;
  phone: string;
  email: string;
  address: string;
}
```

- [ ] **Step 3: Derive the service options and the selected-service lookup inside the component**

In `packages/web/src/components/customer/IntakeFormPage.tsx`, inside the `IntakeFormPage` component body, just after the `tenantInfo` state declaration, add:

```typescript
  // Service options shown in step 1 = the tenant's packs (from the API)
  // joined with local presentation (emoji/copy). Packs with no local
  // presentation entry are skipped rather than rendered blank.
  const serviceOptions = (tenantInfo?.serviceTypes ?? [])
    .filter(
      (st): st is { verticalType: VerticalType; displayName: string } =>
        st.verticalType === 'hvac' || st.verticalType === 'plumbing',
    )
    .map((st) => ({
      verticalType: st.verticalType,
      label: st.displayName,
      ...SERVICE_PRESENTATION[st.verticalType],
    }));
```

Replace the existing `svc` lookup line (`const svc = data.serviceType ? SERVICE_OPTIONS.find(...) : null;`) with:

```typescript
  const svc = data.serviceType
    ? serviceOptions.find((o) => o.verticalType === data.serviceType) ?? null
    : null;
```

- [ ] **Step 4: Update Step 1 rendering to use `serviceOptions`**

In the Step 1 block, replace the `{SERVICE_OPTIONS.map(opt => { ... })}` rendering with the version below. The structural JSX inside is unchanged except `opt.type` → `opt.verticalType`, `opt.label`/`opt.emoji`/`opt.desc` come from the derived option, and a loading/empty state is added:

```tsx
            <div className="flex flex-col gap-3">
              {tenantInfo === null && (
                <p className="text-sm text-slate-400">Loading services…</p>
              )}
              {tenantInfo !== null && serviceOptions.length === 0 && (
                <p className="text-sm text-slate-400">
                  This business hasn't set up online intake yet. Please call to book.
                </p>
              )}
              {serviceOptions.map(opt => {
                const selected = data.serviceType === opt.verticalType;
                return (
                  <button
                    key={opt.verticalType}
                    data-testid={`intake-service-${opt.verticalType}`}
                    onClick={() => update({ serviceType: opt.verticalType })}
                    className={`flex items-center gap-4 rounded-2xl border-2 px-5 py-4 text-left transition-all ${
                      selected
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <span className="text-2xl shrink-0">{opt.emoji}</span>
                    <div className="flex-1">
                      <p className={selected ? 'text-white' : 'text-slate-900'}>{opt.label}</p>
                      <p className={`text-xs mt-0.5 ${selected ? 'text-white/60' : 'text-slate-400'}`}>{opt.desc}</p>
                    </div>
                    <div className={`flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${selected ? 'bg-white border-white' : 'border-slate-300'}`}>
                      {selected && <Check size={11} className="text-slate-900" />}
                    </div>
                  </button>
                );
              })}
            </div>
```

- [ ] **Step 5: Update the Step 2 placeholder and the submit payload to use the new shape**

In the Step 2 block, replace the `<textarea>`'s `placeholder={...}` expression (the three-way `data.serviceType === 'HVAC' ? ... : ...` ternary) with:

```tsx
                placeholder={
                  data.serviceType
                    ? SERVICE_PRESENTATION[data.serviceType].placeholder
                    : FALLBACK_PLACEHOLDER
                }
```

In the `submit()` function, the `description` builder and the `serviceType` payload field currently reference `data.serviceType` (now a lowercase `VerticalType`). Update them to send the human-readable display name via `svc`:

```typescript
      const description = [
        svc ? `Service: ${svc.label}` : null,
        data.urgency ? `Urgency: ${data.urgency}` : null,
        data.description || null,
      ].filter(Boolean).join(' — ');
```

and in the `submitIntakeLead(...)` payload object, change the `serviceType` line to:

```typescript
        serviceType: svc?.label ?? undefined,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/web && npm test -- IntakeFormPage.test.tsx`
Expected: PASS — all nine tests.

- [ ] **Step 7: Run the web typecheck**

Run: `cd packages/web && npm run lint`
Expected: PASS — no type errors. (If `SERVICE_OPTIONS` is referenced anywhere still, the compiler will flag it; all references must now go through `serviceOptions` or `SERVICE_PRESENTATION`.)

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/customer/IntakeFormPage.tsx packages/web/src/components/customer/IntakeFormPage.test.tsx
git commit -m "feat(web): drive intake form service types from tenant vertical packs"
```

---

## Task 7: Web — real business name + phone on the success screen; final verification

**Files:**
- Modify: `packages/web/src/components/customer/IntakeFormPage.tsx`
- Modify: `packages/web/src/components/customer/IntakeFormPage.test.tsx`

- [ ] **Step 1: Add a success-screen branding test (RED)**

In `packages/web/src/components/customer/IntakeFormPage.test.tsx`, add this test inside the `describe` block:

```tsx
  it('shows the real business name and phone on the success screen', async () => {
    render(<IntakeFormPage />);
    await waitFor(() => {
      expect(screen.getByTestId('intake-service-hvac')).toBeInTheDocument();
    });
    await completeWizard();
    await waitFor(() => {
      expect(screen.getByText('Request submitted!')).toBeInTheDocument();
    });
    // Real tenant data, not the hardcoded mock.
    expect(screen.getByText('(512) 555-0100')).toBeInTheDocument();
    expect(screen.getAllByText('Ortega HVAC & Services').length).toBeGreaterThan(0);
    expect(screen.queryByText(/4\.9 on Google/i)).not.toBeInTheDocument();
  });
```

Run: `cd packages/web && npm test -- IntakeFormPage.test.tsx`
Expected: FAIL — the success screen still shows the hardcoded `(512) 555-0100` only by coincidence of the fixture; the `4.9 on Google` mock text is still present, so the last assertion fails. (If the fixture phone differs from the hardcoded value, the phone assertion fails too — that is the real RED.)

- [ ] **Step 2: Make the success screen use `tenantInfo`**

In `packages/web/src/components/customer/IntakeFormPage.tsx`, find the success block (`{step === 'done' && (...)}`). Replace the info-rows array and the trailing star-rating block.

Replace the hardcoded rows array (the `[{ icon: Clock, ... }, { icon: Phone, ... }, { icon: Star, ... }]` literal that is `.map`-ed) with a conditionally-built array:

```tsx
            <div className="w-full flex flex-col gap-3">
              {[
                { icon: Clock, label: 'Expect a call or text within 2 hours', sub: 'Mon–Sat · 7 AM – 6 PM' },
                ...(tenantInfo?.businessPhone
                  ? [{ icon: Phone, label: 'Call us directly', sub: tenantInfo.businessPhone }]
                  : []),
                { icon: Star, label: 'We look forward to helping you', sub: tenantInfo?.businessName ?? 'Your service team' },
              ].map(({ icon: Icon, label, sub }) => (
                <div key={label} className="flex items-center gap-4 rounded-xl bg-white border border-slate-200 px-4 py-3.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100">
                    <Icon size={15} className="text-slate-500" />
                  </span>
                  <div className="text-left">
                    <p className="text-sm text-slate-800">{label}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
                  </div>
                </div>
              ))}
            </div>
```

Then delete the trailing fake-rating block entirely — the `<div className="flex items-center gap-2 mt-2">` containing `{[...Array(5)].map(...)}` stars and the `4.9 on Google · 124 reviews` text.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd packages/web && npm test -- IntakeFormPage.test.tsx`
Expected: PASS — all ten tests.

- [ ] **Step 4: Run the full web test suite and typecheck**

Run: `cd packages/web && npm test`
Expected: PASS — no regressions in other web tests.

Run: `cd packages/web && npm run lint`
Expected: PASS — no type errors. (`Star` is still imported and used in the success rows; no unused-import error.)

- [ ] **Step 5: Run the full API verification**

Run: `cd packages/api && npm test -- test/routes/public-intake.route.test.ts`
Expected: PASS.

Run: `cd packages/api && npx tsc --project tsconfig.build.json --noEmit`
Expected: PASS — exit code 0.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/customer/IntakeFormPage.tsx packages/web/src/components/customer/IntakeFormPage.test.tsx
git commit -m "feat(web): show real tenant name + phone on intake success screen"
```

---

## Self-Review

**1. Spec coverage** — §4's three stated remaining gaps:
- *Test coverage* — Task 4 creates `IntakeFormPage.test.tsx` (characterization), Task 3 creates `public-intake.test.ts`, Task 1 extends the API route test. ✅
- *Real tenant branding* — Task 1 + 2 add and wire the `GET /public/intake/:tenantId` endpoint; Task 5 renders the real business name and drops the mock reviews; Task 7 fixes the success screen. ✅
- *Vertical-pack-driven service types* — Task 6 replaces hardcoded HVAC/Plumbing/Painting with options derived from the tenant's `activeVerticalPacks`. ✅

**2. Placeholder scan** — every code step contains complete, copy-pasteable code. Test commands have exact paths and expected outcomes. No "TBD" / "add error handling" / "similar to Task N". ✅

**3. Type consistency** — the endpoint returns `{ businessName: string, businessPhone: string | null, serviceTypes: { verticalType, displayName }[] }`; the web client's `IntakeTenantInfo` mirrors it exactly; `IntakeServiceType.verticalType` is `string` on the wire and narrowed to `VerticalType` (`'hvac' | 'plumbing'`) inside the component via the `serviceOptions` filter. `submitIntakeLead`'s `SubmitIntakeLeadPayload` matches the API's `intakeSchema` field-for-field. `createPublicIntakeRouter` is called with 5 args in both `app.ts` (Task 2) and the test (Task 1). ✅

**Known cross-task evolution (intentional):** the `IntakeFormPage.test.tsx` `completeWizard` helper and the CTA-disabled test are updated in Task 6 (service test ids change from `intake-service-HVAC` to `intake-service-hvac` when the list becomes pack-driven). Each task states the update explicitly — this is normal TDD evolution as behavior intentionally changes, not a contradiction.
