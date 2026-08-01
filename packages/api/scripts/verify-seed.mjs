#!/usr/bin/env node
/**
 * verify-seed.mjs — seed representative data over the REAL HTTP API so the
 * frontend flows can be driven against the running InMemory server.
 *
 * Run: node packages/api/scripts/verify-seed.mjs
 * Token: read from SEED_TOKEN env (defaults to the dev-bypass owner token).
 *
 * Payloads are grounded in packages/api/src/shared/contracts.ts and the
 * routers under packages/api/src/routes/. Money is integer cents. Times are
 * built by converting tenant-local wall clock -> UTC using the tenant tz
 * reported by GET /api/me.
 */

const BASE = process.env.SEED_BASE || 'http://localhost:3000';
const TOKEN =
  process.env.SEED_TOKEN ||
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJkZXZfb3duZXIiLCJzaWQiOiJkZXYtc2Vzc2lvbiIsInJvbGUiOiJvd25lciJ9.x';

const HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
};

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const err = new Error(
      `${method} ${path} -> ${res.status}: ${
        typeof json === 'string' ? json : JSON.stringify(json)
      }`,
    );
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ── Timezone helpers ─────────────────────────────────────────────────────
// Offset (ms) at a given UTC instant for an IANA tz: local = utc + offset.
function tzOffsetMs(utcDate, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(utcDate)) map[p.type] = p.value;
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - utcDate.getTime();
}

// Convert a wall-clock (y,mo,d,h,mi) in tz to the UTC Date it represents.
function wallClockToUtc(y, mo, d, h, mi, tz) {
  const naiveUTC = Date.UTC(y, mo - 1, d, h, mi, 0);
  let offset = tzOffsetMs(new Date(naiveUTC), tz);
  let utc = naiveUTC - offset;
  offset = tzOffsetMs(new Date(utc), tz); // refine across DST edges
  utc = naiveUTC - offset;
  return new Date(utc);
}

// Today's calendar date (y,mo,d) as observed in tz.
function todayInTz(tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date())) map[p.type] = p.value;
  return { y: Number(map.year), mo: Number(map.month), d: Number(map.day) };
}

function lineItem(idx, description, category, quantity, unitPriceCents, taxable) {
  return {
    id: `li-${idx}`,
    description,
    category,
    quantity,
    unitPriceCents,
    totalCents: quantity * unitPriceCents,
    sortOrder: idx,
    taxable,
    pricingSource: 'manual', // seed prices are manual, i.e. catalog-grounded
  };
}

function listCount(resp) {
  if (Array.isArray(resp)) return resp.length;
  if (resp && Array.isArray(resp.data)) return resp.data.length;
  return 0;
}
function listRows(resp) {
  if (Array.isArray(resp)) return resp;
  if (resp && Array.isArray(resp.data)) return resp.data;
  return [];
}

async function main() {
  const out = { skipped: {} };

  // 1) Tenant timezone
  const me = await req('GET', '/api/me');
  const tz = me.timezone || 'America/New_York';
  out.tenantTimezone = tz;

  // 2) Customer
  const stamp = Date.now();
  const customer = await req('POST', '/api/customers', {
    firstName: 'Dana',
    lastName: `Rivera ${stamp}`,
    primaryPhone: '555-0142',
    email: `dana.rivera+${stamp}@example.com`,
    preferredChannel: 'sms',
    smsConsent: true,
    source: 'referral',
  });
  out.customerId = customer.id;

  // 3) Service location (customer create does NOT embed a location; the web
  //    CustomersPage POSTs /api/locations after creating the customer).
  const location = await req('POST', '/api/locations', {
    customerId: customer.id,
    label: 'Home',
    street1: '482 Maple Avenue',
    city: 'Brooklyn',
    state: 'NY',
    postalCode: '11215',
    accessNotes: 'Gate code 4417; dog in yard.',
    isPrimary: true,
  });
  out.locationId = location.id;

  // 4) Three jobs
  const jobA = await req('POST', '/api/jobs', {
    customerId: customer.id,
    locationId: location.id,
    summary: 'AC not cooling — diagnostic + repair',
    problemDescription: 'Upstairs unit blows warm air; suspect low refrigerant.',
    priority: 'high',
  });
  const jobB = await req('POST', '/api/jobs', {
    customerId: customer.id,
    locationId: location.id,
    summary: 'Water heater replacement (late-evening slot)',
    problemDescription: '40gal tank leaking; customer only available late.',
    priority: 'normal',
  });
  const jobC = await req('POST', '/api/jobs', {
    customerId: customer.id,
    locationId: location.id,
    summary: 'Seasonal furnace tune-up (unscheduled)',
    problemDescription: 'Annual maintenance; not yet scheduled.',
    priority: 'low',
  });
  out.jobs = { A: jobA.id, B: jobB.id, C: jobC.id };

  // 5) Appointments for A (today midday) and B (23:30 tenant-local -> crosses
  //    the UTC day boundary in America/New_York, exercising tz bucketing).
  const t = todayInTz(tz);

  // Job A: today 14:00–16:00 local
  const aStart = wallClockToUtc(t.y, t.mo, t.d, 14, 0, tz);
  const aEnd = new Date(aStart.getTime() + 2 * 60 * 60 * 1000);
  const apptAPayload = {
    jobId: jobA.id,
    scheduledStart: aStart.toISOString(),
    scheduledEnd: aEnd.toISOString(),
    timezone: tz,
    notes: 'Midday diagnostic window.',
  };
  const apptA = await req('POST', '/api/appointments', apptAPayload);

  // Job B: today 23:30–00:30 local (start is next UTC day in EDT)
  const bStart = wallClockToUtc(t.y, t.mo, t.d, 23, 30, tz);
  const bEnd = new Date(bStart.getTime() + 60 * 60 * 1000);
  const apptBPayload = {
    jobId: jobB.id,
    scheduledStart: bStart.toISOString(),
    scheduledEnd: bEnd.toISOString(),
    timezone: tz,
    notes: 'Late-evening slot near the UTC/tenant-day boundary.',
  };
  const apptB = await req('POST', '/api/appointments', apptBPayload);
  out.appointments = { A: apptA.id, B: apptB.id };

  // 6) Estimate attached to Job A (2-3 line items, integer cents).
  const estimatePayload = {
    jobId: jobA.id,
    lineItems: [
      lineItem(0, 'Diagnostic + system inspection', 'labor', 1, 12900, true),
      lineItem(1, 'R-410A refrigerant recharge', 'material', 3, 4500, true),
      lineItem(2, 'Capacitor replacement (45/5 uF)', 'equipment', 1, 8900, true),
    ],
    taxRateBps: 800, // 8.00%
    customerMessage: 'Thanks for choosing us — here is your estimate for the AC repair.',
    internalNotes: 'Seed estimate for runtime verification.',
  };
  const estimate = await req('POST', '/api/estimates', estimatePayload);
  out.estimateId = estimate.id;

  // 7) Draft invoice attached to Job A (1-2 line items).
  const invoicePayload = {
    jobId: jobA.id,
    lineItems: [
      lineItem(0, 'Labor — AC diagnostic & repair', 'labor', 2, 11500, true),
      lineItem(1, 'Parts — capacitor + refrigerant', 'material', 1, 15000, true),
    ],
    taxRateBps: 800,
    customerMessage: 'Invoice for services rendered.',
  };
  const invoice = await req('POST', '/api/invoices', invoicePayload);
  out.invoiceId = invoice.id;

  // ── Verify persistence via list endpoints ───────────────────────────────
  const jobsList = await req('GET', '/api/jobs');
  const estimatesList = await req('GET', '/api/estimates');
  const invoicesList = await req('GET', '/api/invoices');

  // Appointments list: window from yesterday to +2 days (UTC) so both the
  // midday and the boundary-crossing appointment fall inside.
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const apptList = await req(
    'GET',
    `/api/appointments?fromDate=${encodeURIComponent(from)}&toDate=${encodeURIComponent(to)}`,
  );

  const jobRows = listRows(jobsList);
  const estRows = listRows(estimatesList);
  const invRows = listRows(invoicesList);
  const apptRows = listRows(apptList);

  out.verification = {
    jobsCount: listCount(jobsList),
    estimatesCount: listCount(estimatesList),
    invoicesCount: listCount(invoicesList),
    appointmentsInWindow: listCount(apptList),
    seededJobsPresent: [jobA.id, jobB.id, jobC.id].every((id) =>
      jobRows.some((j) => j.id === id),
    ),
    estimatePresent: estRows.some((e) => e.id === estimate.id),
    invoicePresent: invRows.some((i) => i.id === invoice.id),
    appointmentsPresent: [apptA.id, apptB.id].every((id) =>
      apptRows.some((a) => a.id === id),
    ),
  };

  out.payloads = {
    job: {
      customerId: '<customerId>',
      locationId: '<locationId>',
      summary: '<string>',
      problemDescription: '<string?>',
      priority: 'low|normal|high|urgent',
    },
    appointment: apptBPayload,
    estimate: estimatePayload,
    invoice: invoicePayload,
  };

  process.stdout.write('\n=== SEED RESULT (JSON) ===\n');
  process.stdout.write(
    JSON.stringify(
      {
        tenantTimezone: out.tenantTimezone,
        customerId: out.customerId,
        locationId: out.locationId,
        jobs: out.jobs,
        appointments: out.appointments,
        estimateId: out.estimateId,
        invoiceId: out.invoiceId,
        skipped: out.skipped,
      },
      null,
      2,
    ),
  );
  process.stdout.write('\n\n=== VERIFICATION ===\n');
  process.stdout.write(JSON.stringify(out.verification, null, 2));
  process.stdout.write('\n\n=== WORKING PAYLOADS ===\n');
  process.stdout.write(JSON.stringify(out.payloads, null, 2));
  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write(`\nSEED FAILED: ${err.message}\n`);
  if (err.body) process.stderr.write(`${JSON.stringify(err.body, null, 2)}\n`);
  process.exit(1);
});
