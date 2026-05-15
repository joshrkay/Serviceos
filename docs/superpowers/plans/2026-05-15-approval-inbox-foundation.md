# Approval Inbox Foundation (§3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the operator's unified approval inbox. Today the approval surface is scattered across `ConfirmProposalDialog`, `InvoiceProposalActions`, and `ConversationalIntakePage`. This plan delivers (1) a tenant-scoped `/api/proposals/inbox` endpoint that returns ready-for-review proposals sorted by the already-built `prioritizeProposals` urgency model, and (2) a single `/inbox` web page where the operator triages everything with one tap per item.

**Architecture:** No new schema, no new proposal types, no new permissions. The `prioritizeProposals` function in `packages/api/src/proposals/prioritization.ts` already computes per-proposal urgency from `expiresAt`, `confidenceScore`, and `proposalType`. We expose it via a new route, build a list page that consumes it, reuse the existing `POST /api/proposals/:id/approve` and `/reject` endpoints, and back-fill the `ConfirmProposalDialog` test gap that surfaced during reconnaissance.

**Tech Stack:** TypeScript, Node, Express. Tests: vitest + supertest (API) and vitest + @testing-library/react (web). Web: React + Tailwind, `useApiClient` fetch hook, `useListQuery` pattern.

**Out of scope (deferred — documented in TODOS.md):**
- Push notifications for `critical` urgency proposals. Notification infra exists (Twilio/SendGrid) but isn't wired for operator-side push, and operator push channels (web push / native) aren't built. Visual emphasis (red badge, top of list) is the v1 cue.
- The `marketing_message` proposal type (§7's responsibility).
- Per-proposal-type inline editors. The inbox routes complex types (draft_estimate, draft_invoice, reassign_appointment) to their existing per-type editor pages.

---

## Context the executing engineer needs

**Reconnaissance from 2026-05-15:**

- Existing API: `GET /api/proposals/?status=ready_for_review&limit=N&offset=M` (`packages/api/src/routes/proposals.ts:29-49`) — paginated list, no urgency-aware sort. Response `{ data: Proposal[], total: number }`.
- Existing API: `GET /api/proposals/:id` (line 51-70).
- Existing API: `POST /api/proposals/:id/approve` / `/reject` / `/undo` (gated by `proposals:approve` permission).
- `prioritizeProposals(proposals: Proposal[]): PrioritizedProposal[]` already exists at `packages/api/src/proposals/prioritization.ts:72`. Each returned item carries `{ proposal, urgency: 'critical' | 'high' | 'normal' | 'low', reason }`. Sort order: urgency ascending, then `createdAt` ascending, then `TYPE_PRIORITY` ascending. Definitive — do not duplicate or rewrite.
- `ProposalStatus`: "needs operator action" = `'draft' | 'ready_for_review'`. Inbox shows `ready_for_review` only (drafts surface in the conversational intake flow, not the inbox).
- Existing UI fragments:
  - `packages/web/src/components/dispatch/ConfirmProposalDialog.tsx` — Tailwind overlay; has NO test file. Backfill in this PR.
  - `packages/web/src/components/invoices/InvoiceProposalActions.tsx` — inline approve/reject buttons; reuse the action shape.
  - `packages/web/src/pages/dispatcher/ConversationalIntakePage.tsx` — chat-based proposal surface; not the same UX, not replaced.
- Frontend hooks:
  - `packages/web/src/lib/apiClient.ts` `useApiClient()` returns a `fetch`-shaped function that resolves to `Response`. Bearer token auto-injected.
  - `packages/web/src/hooks/useListQuery.ts` wraps `apiFetch` with pagination state — fine for the existing GET endpoint but NOT for the new prioritized inbox (which returns a single capped result set). The page uses a plain `useEffect` + `apiFetch` instead.
- Permission gate: `proposals:view` for read, `proposals:approve` for the action buttons. Already enforced server-side.
- Routes: `packages/web/src/routes.ts:139-171` children array — insert the new `/inbox` route alongside `dispatch`, `dispatcher`, etc.

**Build verification (mandatory, from CLAUDE.md):**

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Production typecheck must be clean before every commit. The default `tsconfig.json` includes test files and is NOT sufficient.

**Commands:**
- API test (one file): from `packages/api`, `npm test -- <relative/path>`
- API full suite: from `packages/api`, `npm test`
- Web test (one file): from `packages/web`, `npm test -- <relative/path>`
- Web typecheck: from `packages/web`, `npx tsc --noEmit`

---

## File Structure

**Created:**
- `packages/api/src/proposals/inbox.ts` — pure function `buildInboxPayload(proposals, cap)` that returns the JSON response shape (calls `prioritizeProposals`, applies the cap, summarizes counts by tier).
- `packages/api/test/proposals/inbox.test.ts` — unit tests for `buildInboxPayload`.
- `packages/api/test/routes/proposals-inbox.route.test.ts` — supertest route test for `GET /api/proposals/inbox`.
- `packages/web/src/components/inbox/InboxPage.tsx` — the page.
- `packages/web/src/components/inbox/InboxPage.test.tsx` — react-testing-library tests.
- `packages/web/src/components/dispatch/ConfirmProposalDialog.test.tsx` — backfilling the recon-identified gap.

**Modified:**
- `packages/api/src/routes/proposals.ts` — add the `GET /inbox` handler.
- `packages/web/src/routes.ts` — register the `/inbox` route.

---

## Task 1: `buildInboxPayload` pure function + `GET /api/proposals/inbox` endpoint

**Files:**
- Create: `packages/api/src/proposals/inbox.ts`
- Create: `packages/api/test/proposals/inbox.test.ts`
- Modify: `packages/api/src/routes/proposals.ts`
- Create: `packages/api/test/routes/proposals-inbox.route.test.ts`

- [ ] **Step 1: Write the failing unit test for `buildInboxPayload`**

Create `packages/api/test/proposals/inbox.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildInboxPayload } from '../../src/proposals/inbox';
import type { Proposal } from '../../src/proposals/proposal';

function makeProposal(over: Partial<Proposal>): Proposal {
  const now = new Date();
  return {
    id: `prop-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: 't1',
    proposalType: 'draft_invoice',
    status: 'ready_for_review',
    payload: {},
    summary: 'A proposal',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const SOON = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes from now
const FAR = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

describe('buildInboxPayload', () => {
  it('returns proposals sorted by urgency tier (critical first)', () => {
    const inbox = buildInboxPayload(
      [
        makeProposal({ id: 'normal-1' }),
        makeProposal({ id: 'critical-1', expiresAt: SOON }),
        makeProposal({ id: 'low-1', confidenceScore: 0.99, proposalType: 'add_note' }),
      ],
      100,
    );
    expect(inbox.data[0].proposal.id).toBe('critical-1');
    expect(inbox.data[0].urgency).toBe('critical');
  });

  it('annotates each row with urgency and reason from prioritizeProposals', () => {
    const inbox = buildInboxPayload(
      [makeProposal({ id: 'p1', expiresAt: SOON })],
      100,
    );
    expect(inbox.data).toHaveLength(1);
    expect(inbox.data[0].urgency).toBe('critical');
    expect(inbox.data[0].reason).toMatch(/expir/i);
  });

  it('reports per-tier counts in the summary', () => {
    const inbox = buildInboxPayload(
      [
        makeProposal({ id: 'a', expiresAt: SOON }),
        makeProposal({ id: 'b', expiresAt: SOON }),
        makeProposal({ id: 'c', expiresAt: FAR }),
      ],
      100,
    );
    expect(inbox.summary.criticalCount).toBe(2);
    expect(inbox.summary.normalCount).toBe(1);
    expect(inbox.summary.totalCount).toBe(3);
  });

  it('caps the response at the given limit and reports truncation', () => {
    const proposals = Array.from({ length: 150 }, (_, i) =>
      makeProposal({ id: `p${i}` }),
    );
    const inbox = buildInboxPayload(proposals, 100);
    expect(inbox.data).toHaveLength(100);
    expect(inbox.summary.totalCount).toBe(150);
    expect(inbox.summary.truncated).toBe(true);
  });

  it('returns an empty payload with zero counts for an empty input', () => {
    const inbox = buildInboxPayload([], 100);
    expect(inbox.data).toEqual([]);
    expect(inbox.summary.totalCount).toBe(0);
    expect(inbox.summary.truncated).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test** — expect FAIL, module not found.

```
cd packages/api && npm test -- test/proposals/inbox.test.ts
```

- [ ] **Step 3: Implement `buildInboxPayload`**

Create `packages/api/src/proposals/inbox.ts`:

```typescript
import { Proposal } from './proposal';
import {
  PrioritizedProposal,
  prioritizeProposals,
} from './prioritization';

/**
 * Inbox response shape for `GET /api/proposals/inbox`. Wraps the
 * already-built `prioritizeProposals` with a server-side cap and
 * per-tier counts so the operator's inbox UI can render a "12 critical"
 * pill without a second query. Pure function — caller fetches the raw
 * proposals from the repo and hands them in.
 */
export interface InboxSummary {
  totalCount: number;
  criticalCount: number;
  highCount: number;
  normalCount: number;
  lowCount: number;
  /** True when `data.length < totalCount`. */
  truncated: boolean;
}

export interface InboxPayload {
  data: PrioritizedProposal[];
  summary: InboxSummary;
}

export function buildInboxPayload(
  proposals: Proposal[],
  cap: number,
): InboxPayload {
  const prioritized = prioritizeProposals(proposals);

  const summary: InboxSummary = {
    totalCount: prioritized.length,
    criticalCount: 0,
    highCount: 0,
    normalCount: 0,
    lowCount: 0,
    truncated: prioritized.length > cap,
  };

  for (const p of prioritized) {
    if (p.urgency === 'critical') summary.criticalCount++;
    else if (p.urgency === 'high') summary.highCount++;
    else if (p.urgency === 'normal') summary.normalCount++;
    else summary.lowCount++;
  }

  return {
    data: prioritized.slice(0, cap),
    summary,
  };
}
```

- [ ] **Step 4: Run the test** — expect PASS (all 5).

- [ ] **Step 5: Write the failing route test**

Create `packages/api/test/routes/proposals-inbox.route.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createProposalsRouter } from '../../src/routes/proposals';
import {
  InMemoryProposalRepository,
  createProposal,
} from '../../src/proposals/proposal';

function buildApp() {
  const proposalRepo = new InMemoryProposalRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-i1',
      sessionId: 'session-i1',
      tenantId: 'tenant-i1',
      role: 'owner',
    };
    next();
  });
  app.use('/api/proposals', createProposalsRouter(proposalRepo));
  return { app, proposalRepo };
}

describe('GET /api/proposals/inbox', () => {
  it('returns ready_for_review proposals sorted by urgency under data + summary', async () => {
    const { app, proposalRepo } = buildApp();
    // Seed: one critical (expires soon), one normal (no expiry).
    const soon = new Date(Date.now() + 30 * 60 * 1000);
    const critical = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'draft_invoice',
      payload: {},
      summary: 'Critical — expires soon',
      createdBy: 'user-i1',
      expiresAt: soon,
    });
    const normal = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'draft_invoice',
      payload: {},
      summary: 'Normal',
      createdBy: 'user-i1',
    });
    // Drafts must be promoted to ready_for_review for the inbox to surface them.
    await proposalRepo.create({ ...critical, status: 'ready_for_review' });
    await proposalRepo.create({ ...normal, status: 'ready_for_review' });

    const res = await request(app).get('/api/proposals/inbox');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].proposal.summary).toMatch(/critical/i);
    expect(res.body.data[0].urgency).toBe('critical');
    expect(res.body.summary).toMatchObject({
      totalCount: 2,
      criticalCount: 1,
      normalCount: 1,
      truncated: false,
    });
  });

  it('excludes proposals not in ready_for_review', async () => {
    const { app, proposalRepo } = buildApp();
    const draft = createProposal({
      tenantId: 'tenant-i1',
      proposalType: 'add_note',
      payload: {},
      summary: 'Draft — should not surface',
      createdBy: 'user-i1',
    });
    await proposalRepo.create(draft); // status: 'draft'
    const res = await request(app).get('/api/proposals/inbox');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('does not leak proposals from other tenants', async () => {
    const { app, proposalRepo } = buildApp();
    const otherTenant = createProposal({
      tenantId: 'tenant-other',
      proposalType: 'add_note',
      payload: {},
      summary: 'From another tenant',
      createdBy: 'user-x',
    });
    await proposalRepo.create({ ...otherTenant, status: 'ready_for_review' });
    const res = await request(app).get('/api/proposals/inbox');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});
```

> If `createProposalsRouter`'s signature has changed (the §1+§5 PR added optional `appointmentRepo`), adapt the call site. Check the file first.

- [ ] **Step 6: Run the test** — expect FAIL (route not registered).

- [ ] **Step 7: Implement the `/inbox` route**

In `packages/api/src/routes/proposals.ts`, add the handler. Place it BEFORE the `GET '/:id'` handler so Express doesn't match `inbox` as an `:id` param:

```typescript
// At the top of the file, with the other proposal imports:
import { buildInboxPayload } from '../proposals/inbox';

// In createProposalsRouter, BEFORE router.get('/:id', ...):
router.get(
  '/inbox',
  requireAuth,
  requireTenant,
  requirePermission('proposals:view'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      // Inbox fetches a capped slice of ready_for_review proposals for the
      // tenant and runs `prioritizeProposals` over them. The 100-item cap
      // keeps the response payload small; if a tenant routinely exceeds
      // it, we'll add pagination — but for a solo operator the inbox is
      // measured in single-digit dozens, not hundreds.
      const all = await proposalRepo.findByTenant(req.auth!.tenantId, {
        status: 'ready_for_review',
        limit: 200, // fetch a buffer above the cap so we don't truncate before sorting
      });
      const inbox = buildInboxPayload(all, 100);
      res.json(inbox);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  },
);
```

> Verify the `proposalRepo.findByTenant` signature accepts `{ status, limit }`. If `limit` isn't a supported option, drop it and let the cap-of-200 happen via `slice` after fetch.

- [ ] **Step 8: Run the route test** — expect PASS (all 3).

- [ ] **Step 9: API production typecheck + commit**

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
git add packages/api/src/proposals/inbox.ts packages/api/src/routes/proposals.ts packages/api/test/proposals/inbox.test.ts packages/api/test/routes/proposals-inbox.route.test.ts
git commit -m "feat(api): add GET /api/proposals/inbox prioritized endpoint"
```

---

## Task 2: `InboxPage` web component

**Files:**
- Create: `packages/web/src/components/inbox/InboxPage.tsx`
- Create: `packages/web/src/components/inbox/InboxPage.test.tsx`
- Modify: `packages/web/src/routes.ts`

- [ ] **Step 1: Write the failing page test**

Create `packages/web/src/components/inbox/InboxPage.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { InboxPage } from './InboxPage';

// useApiClient returns a Response-shaped fetch. Mock at the module boundary.
const apiFetch = vi.fn();
vi.mock('../../lib/apiClient', () => ({
  useApiClient: () => apiFetch,
}));

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('InboxPage', () => {
  beforeEach(() => apiFetch.mockReset());

  it('renders the prioritized proposals sorted by urgency', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: {
              id: 'p-crit',
              proposalType: 'create_booking',
              summary: 'Hold expires in 30 min',
              status: 'ready_for_review',
              createdAt: new Date().toISOString(),
            },
            urgency: 'critical',
            reason: 'Expiring within 2 hours',
          },
          {
            proposal: {
              id: 'p-norm',
              proposalType: 'draft_invoice',
              summary: 'Invoice for the Johnson job',
              status: 'ready_for_review',
              createdAt: new Date().toISOString(),
            },
            urgency: 'normal',
            reason: 'Awaiting review',
          },
        ],
        summary: { totalCount: 2, criticalCount: 1, highCount: 0, normalCount: 1, lowCount: 0, truncated: false },
      }),
    );

    render(<InboxPage />);

    await waitFor(() => {
      expect(screen.getByText('Hold expires in 30 min')).toBeInTheDocument();
      expect(screen.getByText('Invoice for the Johnson job')).toBeInTheDocument();
    });
    // Critical row precedes normal row in the DOM (sorted).
    const rows = screen.getAllByTestId('inbox-row');
    expect(rows[0]).toHaveTextContent('Hold expires in 30 min');
    expect(rows[1]).toHaveTextContent('Invoice for the Johnson job');
    // Critical badge present.
    expect(screen.getByText(/critical/i)).toBeInTheDocument();
  });

  it('shows an empty-state when there are zero proposals', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [],
        summary: { totalCount: 0, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 0, truncated: false },
      }),
    );
    render(<InboxPage />);
    await waitFor(() => {
      expect(screen.getByText(/nothing waiting/i)).toBeInTheDocument();
    });
  });

  it('approves a proposal and removes it from the list optimistically', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: {
              id: 'p-1',
              proposalType: 'add_note',
              summary: 'Add a note',
              status: 'ready_for_review',
              createdAt: new Date().toISOString(),
            },
            urgency: 'low',
            reason: 'Standard priority',
          },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 1, truncated: false },
      }),
    );
    apiFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'p-1', status: 'approved' } }));

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Add a note'));
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(screen.queryByText('Add a note')).not.toBeInTheDocument();
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/proposals/p-1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects a proposal and removes it from the list', async () => {
    apiFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            proposal: {
              id: 'p-2',
              proposalType: 'add_note',
              summary: 'Add another note',
              status: 'ready_for_review',
              createdAt: new Date().toISOString(),
            },
            urgency: 'low',
            reason: 'Standard priority',
          },
        ],
        summary: { totalCount: 1, criticalCount: 0, highCount: 0, normalCount: 0, lowCount: 1, truncated: false },
      }),
    );
    apiFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'p-2', status: 'rejected' } }));

    render(<InboxPage />);
    await waitFor(() => screen.getByText('Add another note'));
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => {
      expect(screen.queryByText('Add another note')).not.toBeInTheDocument();
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/proposals/p-2/reject',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
```

- [ ] **Step 2: Run the test** — expect FAIL (module not found).

- [ ] **Step 3: Implement `InboxPage`**

Create `packages/web/src/components/inbox/InboxPage.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';

type Urgency = 'critical' | 'high' | 'normal' | 'low';

interface InboxProposalRow {
  proposal: {
    id: string;
    proposalType: string;
    summary: string;
    status: string;
    createdAt: string;
  };
  urgency: Urgency;
  reason?: string;
}

interface InboxSummary {
  totalCount: number;
  criticalCount: number;
  highCount: number;
  normalCount: number;
  lowCount: number;
  truncated: boolean;
}

interface InboxResponse {
  data: InboxProposalRow[];
  summary: InboxSummary;
}

const URGENCY_BADGE: Record<Urgency, { label: string; classes: string }> = {
  critical: { label: 'Critical', classes: 'bg-red-100 text-red-800 border-red-200' },
  high: { label: 'High', classes: 'bg-amber-100 text-amber-800 border-amber-200' },
  normal: { label: 'Normal', classes: 'bg-slate-100 text-slate-700 border-slate-200' },
  low: { label: 'Low', classes: 'bg-slate-50 text-slate-500 border-slate-200' },
};

export function InboxPage() {
  const apiFetch = useApiClient();
  const [rows, setRows] = useState<InboxProposalRow[]>([]);
  const [summary, setSummary] = useState<InboxSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiFetch('/api/proposals/inbox')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as InboxResponse;
        if (!cancelled) {
          setRows(body.data);
          setSummary(body.summary);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  async function actOnProposal(id: string, action: 'approve' | 'reject'): Promise<void> {
    // Optimistic remove — the operator should see the row disappear as
    // soon as they tap. If the request fails we re-insert.
    const removed = rows.find((r) => r.proposal.id === id);
    setRows((prev) => prev.filter((r) => r.proposal.id !== id));
    try {
      const res = await apiFetch(`/api/proposals/${id}/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (removed) setRows((prev) => [removed, ...prev]);
      setError(err instanceof Error ? err.message : `${action} failed`);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 md:py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Inbox</h1>
          <p className="text-sm text-slate-500">
            Proposals waiting for your approval. Critical first.
          </p>
          {summary && summary.totalCount > 0 && (
            <p className="text-xs text-slate-500 mt-1">
              {summary.totalCount} waiting
              {summary.criticalCount > 0 && ` · ${summary.criticalCount} critical`}
              {summary.truncated && ' (showing first 100)'}
            </p>
          )}
        </div>

        {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!isLoading && !error && rows.length === 0 && (
          <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
            <p className="text-sm text-slate-700 font-medium">Nothing waiting.</p>
            <p className="text-xs text-slate-500 mt-1">
              When the voice agent or the system needs your approval, it'll show up here.
            </p>
          </div>
        )}

        <ul className="space-y-2">
          {rows.map((row) => {
            const badge = URGENCY_BADGE[row.urgency];
            return (
              <li
                key={row.proposal.id}
                data-testid="inbox-row"
                className="rounded-xl border border-slate-200 bg-white px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${badge.classes}`}
                      >
                        {badge.label}
                      </span>
                      <span className="text-xs text-slate-500">{row.proposal.proposalType}</span>
                    </div>
                    <p className="text-sm text-slate-900 font-medium truncate">
                      {row.proposal.summary}
                    </p>
                    {row.reason && (
                      <p className="text-xs text-slate-500 mt-0.5">{row.reason}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => actOnProposal(row.proposal.id, 'reject')}
                      className="rounded-lg border border-slate-200 bg-white text-slate-700 text-sm px-3 py-1.5 hover:bg-slate-50"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => actOnProposal(row.proposal.id, 'approve')}
                      className="rounded-lg bg-slate-900 text-white text-sm px-3 py-1.5 hover:bg-slate-700"
                    >
                      Approve
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test** — expect PASS (all 4 cases).

- [ ] **Step 5: Register the route**

In `packages/web/src/routes.ts`, add the import near the other reports/page imports:

```typescript
import { InboxPage } from './components/inbox/InboxPage';
```

Add the route to the children array, near the dispatch / reports routes:

```typescript
{ path: 'inbox', Component: InboxPage },
```

- [ ] **Step 6: Web typecheck**

```bash
cd packages/web && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/inbox/InboxPage.tsx packages/web/src/components/inbox/InboxPage.test.tsx packages/web/src/routes.ts
git commit -m "feat(web): add unified Inbox page sorted by urgency"
```

---

## Task 3: Backfill `ConfirmProposalDialog` test

**Files:**
- Create: `packages/web/src/components/dispatch/ConfirmProposalDialog.test.tsx`

The reconnaissance found `ConfirmProposalDialog.tsx` ships without a test file (its three sibling components in `components/dispatch/` all have tests). Add one so future refactors of the dialog catch regressions.

- [ ] **Step 1: Open the component to mirror its prop interface**

Read `packages/web/src/components/dispatch/ConfirmProposalDialog.tsx` — confirm the prop names. The recon report listed: `{ open, proposalType, appointmentSummary, targetDescription, isSubmitting, onConfirm, onCancel }`.

- [ ] **Step 2: Write the tests**

Create `packages/web/src/components/dispatch/ConfirmProposalDialog.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmProposalDialog } from './ConfirmProposalDialog';

describe('ConfirmProposalDialog', () => {
  const baseProps = {
    open: true,
    proposalType: 'reschedule_appointment' as const,
    appointmentSummary: 'HVAC tune-up @ 123 Main St',
    targetDescription: 'Tomorrow 9:00 AM',
    isSubmitting: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it('renders the summary and target when open', () => {
    render(<ConfirmProposalDialog {...baseProps} />);
    expect(screen.getByText('HVAC tune-up @ 123 Main St')).toBeInTheDocument();
    expect(screen.getByText('Tomorrow 9:00 AM')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    const { container } = render(<ConfirmProposalDialog {...baseProps} open={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onConfirm when the primary action is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmProposalDialog {...baseProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: /confirm|approve|reschedule|cancel appointment|reassign/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when the secondary action is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmProposalDialog {...baseProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel|dismiss|back/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disables the primary action while submitting', () => {
    render(<ConfirmProposalDialog {...baseProps} isSubmitting={true} />);
    // The primary action button (the one wired to onConfirm) should be disabled.
    const confirmButton = screen.getByRole('button', { name: /confirm|approve|reschedule|cancel appointment|reassign|submitting/i });
    expect(confirmButton).toBeDisabled();
  });
});
```

> The component's exact button labels depend on `proposalType` — read the source first and adjust the regex matchers if needed. If the button is rendered via something other than `<button>`, switch to `getByText` or a `data-testid`.

- [ ] **Step 3: Run the test** — expect PASS. If it fails, adjust the regex matchers to the actual button labels (the test is a contract on the component's *behavior*, not its exact copy — fix the matchers, not the component).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/dispatch/ConfirmProposalDialog.test.tsx
git commit -m "test(web): backfill ConfirmProposalDialog test coverage"
```

---

## Task 4: Final verification

**Files:** none — verification only.

- [ ] **Step 1: API production typecheck**

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expect: no errors.

- [ ] **Step 2: API test suite (full)**

```bash
cd packages/api && npm test
```

Expect: all green except known pre-existing failures (`dispatch/validation`, `invoices/invoice` calculateDueDate date-sensitive, `voice/whisper-transcription` timeout — confirmed to fail on main snapshot during prior PRs).

- [ ] **Step 3: Web typecheck**

```bash
cd packages/web && npx tsc --noEmit
```

Expect: no errors.

- [ ] **Step 4: Web test (focused)**

```bash
cd packages/web && npm test -- src/components/inbox src/components/dispatch/ConfirmProposalDialog.test.tsx
```

Expect: all new tests pass.

- [ ] **Step 5: Spec coverage check**

Cross-check against §3 of `docs/superpowers/specs/2026-05-14-serviceos-launch-readiness-design.md`:
- ✅ Unified inbox: `/api/proposals/inbox` + `InboxPage`.
- ✅ Plain-language summary + approve/reject (the proposal `summary` field is what the operator reads).
- ✅ Sorted by urgency, critical badge on top.
- ✅ Idempotent execution: unchanged — uses the existing `POST /:id/approve` and `/reject` which already have the executor idempotency guard.
- ⚠️ **Deferred:** push notifications for critical urgency. Visual emphasis only in v1. Add to TODOS.md.
- ⚠️ **Deferred:** `marketing_message` proposal type — §7's responsibility, not §3.
- ⚠️ **Deferred:** per-proposal-type inline editors — complex types route to existing per-type editor pages.

- [ ] **Step 6: Add deferred items to TODOS.md and commit**

Append the deferral block to `TODOS.md`:

```markdown
## Push notifications for critical-urgency proposals

§3 launched with visual urgency cues in the inbox only. Notification
infrastructure exists (Twilio/SendGrid) but is customer-facing — no
operator push channel is wired. For solo operators who keep the inbox
open during business hours, visual cues are sufficient. The gap
appears when a tenant scales past one operator or wants out-of-app
alerts (web push, native push, SMS-to-self).

**Fix:** wire `urgency === 'critical'` rows to fire a push notification
to the operator's registered channel. Needs (1) an operator-channel
registry (web push subscription + optional SMS-to-self per user) and
(2) a hook from the proposal create path so the moment a critical
proposal becomes `ready_for_review`, the push fires.

**Effort:** ~2 hours CC, separate PR.
```

```bash
git add TODOS.md
git commit -m "docs: defer operator push notifications to follow-up PR"
```

- [ ] **Step 7: Finish the branch**

Use the **superpowers:finishing-a-development-branch** skill to push and create the PR.

---

## Self-Review

**Spec coverage:** §3's minimum credible version maps to the four tasks: Task 1 builds the prioritized list endpoint, Task 2 builds the page, Task 3 closes the recon-identified `ConfirmProposalDialog` test gap, Task 4 verifies. The two large deferrals (push notifications, `marketing_message`) are explicitly out-of-scope and called out in Task 4 Step 5.

**Placeholder scan:** Every code step shows the full file or the exact edit. The few `>` notes are defensive instructions for places where the executing engineer should verify the existing-code shape first (`createProposalsRouter` signature, `ConfirmProposalDialog` button labels) — they point at the authoritative source file, not vague guidance.

**Type consistency:** `InboxPayload` / `InboxSummary` / `buildInboxPayload` are defined in Task 1 and consumed in Task 2 via the API contract (the web declares its own narrow types — both sides agree on the JSON shape). `PrioritizedProposal` / `prioritizeProposals` come from the existing `packages/api/src/proposals/prioritization.ts` and are not redefined.

**No schema changes.** Reuses existing `Proposal` entity, existing `ProposalStatus`, existing permission keys, existing approval / reject endpoints. The migration count stays where main left it.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-15-approval-inbox-foundation.md`.**

Execute via **superpowers:subagent-driven-development** (recommended): fresh implementer subagent per task with two-stage review (spec compliance, then code quality). Four tasks → four implementer dispatches → final code review at the end.
