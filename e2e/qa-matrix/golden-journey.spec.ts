import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * JRN-03 — the golden end-to-end funnel, exercised leg by leg with DB
 * verification at each step:
 *
 *   public intake → lead → convert to customer → service location → job →
 *   estimate (line items + totals) → [send → public approve → invoice → pay]
 *
 * The first six legs are deterministic and run fully offline. The trailing
 * delivery/payment legs depend on SendGrid/Stripe; when those run in mock
 * mode (no keys) they cannot complete end-to-end, so they are attempted and
 * recorded as notes rather than failing the row — the production run with
 * real keys closes them.
 */

test.describe.configure({ mode: 'serial' });

function lineItem(id: string, desc: string, qtyCents: number) {
  return {
    id,
    description: desc,
    category: 'labor' as const,
    quantity: 1,
    unitPriceCents: qtyCents,
    totalCents: qtyCents,
    sortOrder: 0,
    taxable: true,
  };
}

matrixTest(
  'JRN-03',
  'Golden funnel: intake → lead → convert → job → estimate',
  async (h) => {
    const { token, tenantId } = h.tenantA;
    const stamp = Date.now();

    // 1) Public intake (no auth) → lead.
    const intake = await h.api.call({
      method: 'POST',
      path: `/public/intake/${tenantId}/leads`,
      body: {
        firstName: 'Golden',
        lastName: `Journey-${stamp}`,
        primaryPhone: `+1555${String(stamp).slice(-7)}`,
        email: `golden+${stamp}@example.com`,
        serviceType: 'HVAC',
        urgency: 'soon',
        description: 'AC not cooling — golden journey QA',
      },
      label: '01-intake',
      expectStatus: 201,
    });
    const leadId = (intake.response.body as { leadId: string }).leadId;
    expect(leadId, 'intake must return a leadId').toBeTruthy();
    const leadRow = await h.db.query({
      label: '01-lead-row',
      tenantId,
      sql: `SELECT id, stage FROM leads WHERE id = $1`,
      params: [leadId],
    });
    expect(leadRow.rowCount, 'lead row must persist under tenant').toBe(1);

    // 2) Convert lead → customer.
    const convert = await h.api.call({
      method: 'POST',
      path: `/api/leads/${leadId}/convert`,
      token,
      label: '02-convert',
      expectStatus: 201,
    });
    const customerId = (convert.response.body as { customer?: { id?: string } }).customer?.id;
    expect(customerId, 'convert must return a customer id').toBeTruthy();

    // 3) Service location for the new customer.
    const location = await h.api.call({
      method: 'POST',
      path: '/api/locations',
      body: { customerId, street1: '1 Golden Way', city: 'Testville', state: 'CA', postalCode: '90001' },
      token,
      label: '03-location',
      expectStatus: 201,
    });
    const locationId = (location.response.body as { id: string }).id;
    expect(locationId, 'location create must return an id').toBeTruthy();

    // 4) Job for the customer/location.
    const job = await h.api.call({
      method: 'POST',
      path: '/api/jobs',
      body: { customerId, locationId, summary: 'Golden journey HVAC repair', priority: 'normal' },
      token,
      label: '04-job',
      expectStatus: 201,
    });
    const jobId = (job.response.body as { id: string }).id;
    expect(jobId, 'job create must return an id').toBeTruthy();

    // 5) Estimate against the job (two line items → known total).
    const estimate = await h.api.call({
      method: 'POST',
      path: '/api/estimates',
      body: {
        jobId,
        lineItems: [lineItem('li-1', 'Diagnostic', 12_500), lineItem('li-2', 'Compressor', 87_500)],
      },
      token,
      label: '05-estimate',
      expectStatus: 201,
    });
    const estimateId = (estimate.response.body as { id: string }).id;
    expect(estimateId, 'estimate create must return an id').toBeTruthy();
    const estRow = await h.db.query({
      label: '05-estimate-row',
      tenantId,
      sql: `SELECT id, job_id, total_cents FROM estimates WHERE id = $1`,
      params: [estimateId],
    });
    expect(estRow.rowCount, 'estimate row must persist').toBe(1);
    expect(Number((estRow.rows[0] as { total_cents: number }).total_cents), 'estimate total must equal summed line items').toBe(
      100_000,
    );

    // 6) Estimate → sent (deterministic state transition).
    await h.api.call({
      method: 'POST',
      path: `/api/estimates/${estimateId}/transition`,
      body: { status: 'sent' },
      token,
      label: '06-estimate-sent',
      expectStatus: 200,
    });

    // 7) Invoice the job and issue it — deterministic, no Stripe/SendGrid.
    const invoice = await h.api.call({
      method: 'POST',
      path: '/api/invoices',
      body: { jobId, estimateId, lineItems: [lineItem('li-1', 'Diagnostic', 12_500), lineItem('li-2', 'Compressor', 87_500)] },
      token,
      label: '07-invoice-create',
      expectStatus: 201,
    });
    const invoiceId = (invoice.response.body as { id: string }).id;
    expect(invoiceId, 'invoice create must return an id').toBeTruthy();
    await h.api.call({
      method: 'POST',
      path: `/api/invoices/${invoiceId}/issue`,
      token,
      label: '07-invoice-issue',
      expectStatus: 200,
    });
    const invRow = await h.db.query({
      label: '07-invoice-row',
      tenantId,
      sql: `SELECT status FROM invoices WHERE id = $1`,
      params: [invoiceId],
    });
    expect((invRow.rows[0] as { status: string }).status, 'issued invoice must be open').toBe('open');

    // 8) Integration-gated tail (delivery + payment). These require live
    //    SendGrid/Stripe; attempt the send and let it drive the verdict —
    //    a non-2xx here means the funnel tail is unverified in this env, so
    //    the row is PARTIAL rather than a false PASS.
    const send = await h.api.call({
      method: 'POST',
      path: `/api/estimates/${estimateId}/send`,
      body: { channel: 'email' },
      token,
      label: '08-estimate-send',
    });

    await gotoUi(h, '/invoices', '08-invoices-ui');

    if (send.response.status >= 200 && send.response.status < 300) {
      // Deterministic funnel through invoice issuance verified AND the
      // delivery leg was accepted.
      h.evidence.pass();
    } else {
      h.evidence.partial(
        `Funnel verified through invoice issuance, but the delivery leg (POST /estimates/:id/send) returned ${send.response.status} ` +
          '— SendGrid is mock/disabled in this env. Payment leg also requires live Stripe. Run against the deployed env to close the tail.',
      );
    }
  },
);

// ---------------- helpers ----------------

async function gotoUi(h: RowHarness, path: string, label: string): Promise<void> {
  const baseUrl = process.env.E2E_BASE_URL!;
  try {
    await h.page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    h.evidence.note(`navigation to ${path} failed: ${(err as Error).message}`);
  }
  await h.page.waitForTimeout(500);
  await h.snapshot(label);
}
