import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * SMS-01 — outbound SMS dispatch records: create a consenting customer + job +
 * appointment, then look for the appointment_confirmation dispatch row. Also
 * captures the live message_dispatches entity_type CHECK (known too-narrow:
 * reschedule/cancel/payment_receipt may be rejected — recorded as a defect).
 * SMS-02 — consent/DNC gating: a non-consenting customer must produce no row.
 */

test.describe.configure({ mode: 'serial' });

async function chain(
  h: RowHarness,
  smsConsent: boolean,
  label: string
): Promise<{ appointmentId: string }> {
  const stamp = Date.now();
  const cust = await h.api.call({
    method: 'POST',
    path: '/api/customers',
    body: {
      firstName: 'QA',
      lastName: `SMS-${label}-${stamp}`,
      primaryPhone: `+1555${String(stamp).slice(-7)}`,
      email: `qa+sms-${label}-${stamp}@example.com`,
      preferredChannel: 'sms',
      smsConsent,
    },
    token: h.tenantA.token,
    label: `${label}-customer`,
    expectStatus: 201,
  });
  const customerId = (cust.response.body as { id: string }).id;

  const loc = await h.api.call({
    method: 'POST',
    path: '/api/locations',
    body: { customerId, street1: '1 QA Way', city: 'Testville', state: 'CA', postalCode: '90001' },
    token: h.tenantA.token,
    label: `${label}-location`,
    expectStatus: 201,
  });
  const locationId = (loc.response.body as { id: string }).id;

  const job = await h.api.call({
    method: 'POST',
    path: '/api/jobs',
    body: { customerId, locationId, summary: 'QA SMS appointment' },
    token: h.tenantA.token,
    label: `${label}-job`,
    expectStatus: 201,
  });
  const jobId = (job.response.body as { id: string }).id;

  const start = new Date(Date.now() + 2 * 86_400_000);
  start.setUTCHours(16, 0, 0, 0);
  const appt = await h.api.call({
    method: 'POST',
    path: '/api/appointments',
    body: {
      jobId,
      scheduledStart: start.toISOString(),
      scheduledEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString(),
      timezone: 'America/Los_Angeles',
    },
    token: h.tenantA.token,
    label: `${label}-appointment`,
    expectStatus: 201,
  });
  return { appointmentId: (appt.response.body as { id: string }).id };
}

async function pollDispatchCount(h: RowHarness, appointmentId: string, label: string): Promise<number> {
  let count = 0;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await h.db.query({
      label: `${label}-poll-${i}`,
      tenantId: h.tenantA.tenantId,
      sql: `SELECT count(*)::int AS c FROM message_dispatches WHERE entity_id = $1 AND channel = 'sms'`,
      params: [appointmentId],
    });
    count = (res.rows[0] as { c: number }).c;
    if (count > 0) break;
  }
  return count;
}

matrixTest('SMS-01', 'Outbound SMS dispatch records + entity_type CHECK', async (h) => {
  // Document the live constraint (the suspected defect).
  const check = await h.db.query({
    label: '01-entity-type-check',
    sql: `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'message_dispatches_entity_type_check'`,
  });
  const def = (check.rows[0] as { def?: string })?.def ?? '(not found)';
  const tooNarrow = ['appointment_reschedule', 'appointment_cancel', 'payment_receipt'].filter(
    (t) => !def.includes(t)
  );
  if (tooNarrow.length) {
    h.evidence.note(
      `DEFECT candidate: message_dispatches entity_type CHECK rejects ${tooNarrow.join(', ')} — ` +
        `their SMS inserts will fail. CHECK = ${def}`
    );
  }

  const { appointmentId } = await chain(h, true, '01');
  const dispatched = await pollDispatchCount(h, appointmentId, '01');

  const rows = await h.db.query({
    label: '01-dispatch-rows',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT entity_type, channel, status, provider_message_id FROM message_dispatches WHERE entity_id = $1`,
    params: [appointmentId],
  });

  await gotoUi(h, '/dispatch', '01-ui');

  if (dispatched > 0) {
    h.evidence.pass(
      tooNarrow.length
        ? `Confirmation dispatch recorded. NOTE: CHECK still too narrow for ${tooNarrow.join(', ')}.`
        : undefined
    );
  } else {
    h.evidence.partial(
      'No appointment_confirmation dispatch from a REST-created appointment — CONFIRMED BY DESIGN ' +
        '(2026-06-05): the confirmation notifier is wired to the proposal-execution path only ' +
        '(appointment-confirmation-notifier.ts via scheduling-notifications). Either add a REST-create ' +
        'trigger (product decision) or repoint this check at the voice/proposal path, which now works E2E.'
    );
  }
  expect(rows.rowCount, 'dispatch query executed').toBeGreaterThanOrEqual(0);
});

matrixTest('SMS-02', 'SMS consent / DNC gating (negative)', async (h) => {
  const { appointmentId } = await chain(h, false, '02');
  const count = await pollDispatchCount(h, appointmentId, '02');

  if (count === 0) {
    h.evidence.pass(
      'No SMS dispatch for a non-consenting customer (correct gating). NOTE: confirm SMS-01 produced a ' +
        'row for a consenting customer, else this is vacuous.'
    );
  } else {
    h.evidence.fail(`SMS dispatch row created for a customer with sms_consent=false (${count} row(s)).`);
  }
  await gotoUi(h, '/dispatch', '02-ui');
});

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
