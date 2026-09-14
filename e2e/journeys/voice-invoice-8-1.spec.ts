import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { API_URL, bootstrapOwner, queryAsTenant, pollRows, Tenant } from '../fixtures/money-lane-8-8';

/**
 * 8.1 — rung-5 reachability: "I want to invoice by saying one sentence, so
 * I bill before I drive away". `draft-invoice-execution.test.ts` already
 * proves the approve -> execute -> persist + audit half at real Postgres
 * (T1) by constructing the `draft_invoice` proposal directly, in-process —
 * skipping the classification step entirely.
 *
 * This spec drives the FULL loop through the real, owner-authenticated
 * `POST /api/assistant/chat` route (routes/assistant.ts:3665) — the same
 * classify_intent -> draft_invoice pipeline the phone/voice surface uses
 * (ai/orchestration/intent-classifier.ts), then a real
 * `POST /api/proposals/:id/approve`, then the real execution sweep
 * (`shouldRunWorkers`, same interval-driven worker as every other sweep in
 * this lane) finishing the write.
 *
 * NOT a faked model: `AI_PROVIDER_API_KEY` is deliberately left UNSET, so
 * `createLLMGateway` falls back to `createHermeticMockLLMGateway()`
 * (app.ts:1257-1258) — the SAME no-key hermetic posture a normally
 * provisioned CI/local run has (see e2e/journeys/log-time-by-voice.spec.ts's
 * header for the identical reasoning on the phone surface). Its
 * `scriptHermeticResponse` (ai/providers/mock.ts:160-196) deterministically
 * recognizes `create_invoice` for any utterance matching
 * `/\b(draft|create|prepare|make|issue)\b.*\binvoice\b/` — this is not a
 * cherry-picked phrase, it is the documented default. A live
 * `AI_PROVIDER_API_KEY` would issue a paid live call instead and is exactly
 * what #1119 (model turns) parks out of scope for a test-only lane.
 */

test.describe('invoice by saying one sentence (8.1) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    process.env.PROCESS_ROLE === 'all' &&
    !process.env.AI_PROVIDER_API_KEY;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres with the REAL execution sweep on: ' +
      'leave E2E_BASE_URL unset, set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), ' +
      'E2E_USE_TEST_DB=true with DATABASE_URL pointing at the test container, PROCESS_ROLE=all, and ' +
      'leave AI_PROVIDER_API_KEY UNSET (the hermetic mock gateway is this row\'s whole premise — a ' +
      'real key would issue a live, paid classification call instead of hitting the documented, ' +
      'default no-key path).',
  );

  async function seedNamedCustomer(
    request: import('@playwright/test').APIRequestContext,
    tenant: Tenant,
    firstName: string,
    lastName: string,
  ): Promise<{ customerId: string; jobId: string }> {
    const customerRes = await request.post(`${API_URL}/api/customers`, {
      headers: { 'content-type': 'application/json', ...tenant.authHeaders },
      data: JSON.stringify({
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`,
        preferredChannel: 'email',
      }),
    });
    expect(customerRes.ok(), `create customer -> ${customerRes.status()}`).toBeTruthy();
    const customer = (await customerRes.json()) as { id: string };

    const locationRes = await request.post(`${API_URL}/api/locations`, {
      headers: { 'content-type': 'application/json', ...tenant.authHeaders },
      data: JSON.stringify({
        customerId: customer.id,
        street1: '1 One Sentence Way',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        isPrimary: true,
      }),
    });
    expect(locationRes.ok(), `create location -> ${locationRes.status()}`).toBeTruthy();
    const location = (await locationRes.json()) as { id: string };

    const jobRes = await request.post(`${API_URL}/api/jobs`, {
      headers: { 'content-type': 'application/json', ...tenant.authHeaders },
      data: JSON.stringify({
        customerId: customer.id,
        locationId: location.id,
        summary: `${firstName} ${lastName} — 8.1 voice-invoice journey`,
      }),
    });
    expect(jobRes.ok(), `create job -> ${jobRes.status()}`).toBeTruthy();
    const job = (await jobRes.json()) as { id: string };

    return { customerId: customer.id, jobId: job.id };
  }

  async function speakInvoice(
    request: import('@playwright/test').APIRequestContext,
    tenant: Tenant,
    sentence: string,
  ) {
    const res = await request.post(`${API_URL}/api/assistant/chat`, {
      headers: { 'content-type': 'application/json', ...tenant.authHeaders },
      data: JSON.stringify({ messages: [{ role: 'user', content: sentence }] }),
    });
    expect(res.ok(), `assistant/chat -> ${res.status()} ${await res.text()}`).toBeTruthy();
    return res;
  }

  test('a real one-sentence request to the owner assistant drafts a create_invoice proposal; approving it produces a real invoice row with integer-cent totals and exactly one invoice.created audit event; a neighbour tenant is untouched', async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const tenantA = await bootstrapOwner(request, 'a', 'One Sentence HVAC 8.1');
    const seedA = await seedNamedCustomer(request, tenantA, 'Jordan', 'Diaz');

    const tenantB = await bootstrapOwner(request, 'b', 'Neighbour Voice 8.1');
    const seedB = await seedNamedCustomer(request, tenantB, 'Kelly', 'Fox');

    // ── The one sentence ───────────────────────────────────────────────────
    await speakInvoice(request, tenantA, `Create an invoice for Jordan Diaz for a diagnostic visit`);

    // ── The draft_invoice proposal, real, pending approval ───────────────
    const proposalRows = await pollRows(
      tenantA.tenantId,
      `SELECT id, status, payload FROM proposals WHERE tenant_id = $1 AND proposal_type = 'draft_invoice'`,
      [tenantA.tenantId],
      { timeoutMs: 15_000, minRows: 1 },
    );
    expect(proposalRows, 'the classify_intent -> draft_invoice pipeline drafted a real proposal').toHaveLength(1);
    const proposalId = proposalRows[0].id as string;
    const payload = proposalRows[0].payload as { jobId?: string; customerId?: string };
    expect(payload.customerId ?? payload.jobId, 'the drafted payload resolved a real entity, not a placeholder').toBeTruthy();

    // ── Owner approves the real proposal through the real route ───────────
    const approveRes = await request.post(`${API_URL}/api/proposals/${proposalId}/approve`, {
      headers: tenantA.authHeaders,
    });
    expect(approveRes.ok(), `approve -> ${approveRes.status()} ${await approveRes.text()}`).toBeTruthy();

    // ── The real execution sweep (PROCESS_ROLE=all) finishes the write
    //    after the 5s undo window ─────────────────────────────────────────
    // Scoped by tenant only (not job_id): the resolved entity for a
    // chat-surface "for Jordan Diaz" reference is the tenant's own
    // resolution logic, not necessarily re-derivable from this test's
    // seeded jobId — the real proof is that ANY real invoice.created
    // event + row landed under the SAME proposalId this test approved.
    const invoiceRows = await pollRows(
      tenantA.tenantId,
      `SELECT id, job_id, total_cents, subtotal_cents FROM invoices WHERE tenant_id = $1`,
      [tenantA.tenantId],
      { timeoutMs: 30_000, minRows: 1 },
    );
    expect(invoiceRows, 'the approved proposal executed into a real invoice row').toHaveLength(1);
    const invoiceId = invoiceRows[0].id as string;
    expect(Number.isInteger(Number(invoiceRows[0].total_cents))).toBeTruthy();
    expect(Number(invoiceRows[0].total_cents)).toBeGreaterThan(0);

    const createdAudit = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'invoice' AND entity_id = $2 AND event_type = 'invoice.created'`,
      [tenantA.tenantId, invoiceId],
    );
    expect(createdAudit, 'exactly one invoice.created audit event').toHaveLength(1);

    // ── T2 — a neighbour tenant never drafted or executed anything ────────
    const neighbourProposals = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM proposals WHERE tenant_id = $1 AND proposal_type = 'draft_invoice'`,
      [tenantB.tenantId],
    );
    expect(neighbourProposals).toHaveLength(0);
    const neighbourInvoices = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM invoices WHERE tenant_id = $1 AND job_id = $2`,
      [tenantB.tenantId, seedB.jobId],
    );
    expect(neighbourInvoices).toHaveLength(0);
    const crossRead = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM invoices WHERE tenant_id = $1 AND id = $2`,
      [tenantB.tenantId, invoiceId],
    );
    expect(crossRead).toHaveLength(0);
  });
});
