import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';
import { startVoiceSession } from './helpers/voice-flow';
import { rwAvailable, rwExec } from './helpers/rw-db';

/**
 * VOX-01 — emergency triage fast-path (voice; real LLM).
 * VOX-02 — Spanish / i18n voice response (real LLM, soft language check).
 * VOX-03 — DNC suppression of outbound SMS (RW-seeded DNC entry).
 * VOX-04 — documents the telephony-only cases not drivable in simulated mode.
 */

test.describe.configure({ mode: 'serial' });

async function submit(h: RowHarness, sessionId: string, text: string, label: string) {
  return h.api.call({
    method: 'POST',
    path: `/api/voice/sessions/${sessionId}/input`,
    body: { text },
    token: h.tenantA.token,
    label,
    expectStatus: [200, 400, 403, 404],
  });
}

matrixTest('VOX-01', 'Emergency triage fast-path (voice)', async (h) => {
  const sessionId = await startVoiceSession(h, h.tenantA.token, '01');
  if (!sessionId) return void h.evidence.fail('Voice session could not be started.');

  const res = await submit(
    h,
    sessionId,
    'My furnace is completely out and I can smell gas in the house right now — this is an emergency',
    '01-input'
  );
  if (res.response.status !== 200) {
    return void h.evidence.fail(`Voice input returned ${res.response.status}; AI pipeline not ready (Real-LLM-only).`);
  }
  const blob = JSON.stringify(res.response.body).toLowerCase();
  const escalated = ['escalat', 'emergency', 'urgent', 'on-call', 'oncall', 'right away', 'dispatch'].some((k) =>
    blob.includes(k)
  );
  if (escalated) {
    h.evidence.pass('Emergency utterance routed to escalation / urgent handling.');
  } else {
    h.evidence.partial('Voice responded but no clear emergency/escalation signal in the turn — review captured response.');
  }
});

matrixTest('VOX-02', 'Spanish / i18n voice response', async (h) => {
  const sessionId = await startVoiceSession(h, h.tenantA.token, '02');
  if (!sessionId) return void h.evidence.fail('Voice session could not be started.');

  const res = await submit(
    h,
    sessionId,
    'Hola, necesito ayuda con mi aire acondicionado que no enfría y quisiera agendar una visita por favor',
    '02-input'
  );
  if (res.response.status !== 200) {
    return void h.evidence.partial(`Voice input returned ${res.response.status}; cannot assess language handling.`);
  }
  const tts = ((res.response.body as { ttsText?: string }).ttsText ?? '').toLowerCase();
  // Whole-word match on distinctive Spanish tokens (avoid short substrings
  // like "su"/"para" matching inside English words).
  const words = new Set(tts.split(/[^a-záéíóúñ¿¡]+/).filter(Boolean));
  const spanishMarkers = [
    'gracias', 'hola', 'puedo', 'pueda', 'ayuda', 'ayudarle', 'cita', 'podemos', 'usted',
    'necesita', 'agendar', 'disculpe', 'perfecto', 'registrado', 'confirmación', 'recibirá',
    'breve', 'correcto', 'desea',
  ];
  // Accented Spanish characters are unambiguous on their own.
  const looksSpanish = spanishMarkers.some((m) => words.has(m)) || /[¿¡ñáéíóú]/.test(tts);
  if (tts && looksSpanish) {
    h.evidence.pass('Voice responded in Spanish to a Spanish utterance.');
  } else {
    h.evidence.partial(`Response captured but Spanish not clearly detected (ttsText="${tts.slice(0, 80)}").`);
  }
});

matrixTest('VOX-03', 'DNC suppression of outbound SMS', async (h) => {
  if (!rwAvailable()) {
    h.evidence.na('E2E_DB_URL_READWRITE not set — cannot seed a DNC entry.');
    return;
  }
  const dncPhone = '+15555550199';
  try {
    await rwExec(
      h.tenantA.tenantId,
      `INSERT INTO tenant_dnc_list (tenant_id, phone, added_by)
       VALUES ($1, $2, 'qa') ON CONFLICT DO NOTHING`,
      [h.tenantA.tenantId, dncPhone]
    );
  } catch (err) {
    h.evidence.na(`Could not seed DNC (schema differs?): ${(err as Error).message}`);
    return;
  }

  // Send an estimate by SMS to the DNC number; it must be suppressed.
  const est = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: {
      jobId: h.tenantA.jobId,
      lineItems: [{ id: 'li-1', description: 'Service', category: 'labor', quantity: 1, unitPriceCents: 12000, totalCents: 12000, sortOrder: 0, taxable: false }],
      discountCents: 0,
      taxRateBps: 0,
    },
    token: h.tenantA.token,
    label: '03-estimate',
    expectStatus: 201,
  });
  const estimateId = (est.response.body as { id: string }).id;

  const send = await h.api.call({
    method: 'POST',
    path: `/api/estimates/${estimateId}/send`,
    body: { channel: 'sms', recipientPhone: dncPhone },
    token: h.tenantA.token,
    label: '03-send',
    expectStatus: [200, 202, 400, 403, 503],
  });
  // For an SMS-only send to a DNC number, suppression yields 400 (no channel
  // actually sent). 200/202/400 all mean "attempted" — proceed to verify no SMS.
  if (![200, 202, 400].includes(send.response.status)) {
    h.evidence.na(`Estimate send returned ${send.response.status}; DNC path not exercised.`);
    return;
  }

  await new Promise((r) => setTimeout(r, 3000));
  const sent = await h.db.query({
    label: '03-no-dispatch',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT count(*)::int AS c FROM message_dispatches
          WHERE entity_id = $1 AND channel = 'sms'`,
    params: [estimateId],
  });
  const c = (sent.rows[0] as { c: number }).c;
  if (c === 0) h.evidence.pass('No SMS dispatch attempt for the DNC number on this estimate (suppressed correctly).');
  else h.evidence.fail(`${c} SMS dispatch row(s) for a DNC-listed number — suppression not honored (any attempt counts).`);
});

matrixTest('VOX-04', 'Telephony-only edge cases (documented coverage gap)', async (h) => {
  // No API/DB to drive — these need live Twilio (signed webhooks / a real call)
  // or non-API config, so they're documented rather than executed in this mode.
  h.evidence.note('Business-hours enforcement: in-app sessions are not blocked; after-hours voicemail is telephony-only.');
  h.evidence.note('Maintenance-plan caller context: in-app sessions have no caller phone, so identify_caller cannot resolve the plan.');
  h.evidence.note('Phone rate-limiting (phone_rate_limits): keyed by inbound phone number — not exercised by in-app sessions.');
  h.evidence.note('Tech "I\'m out today" SMS (P6-028): inbound SMS webhook requires a valid X-Twilio-Signature (cannot be forged).');
  h.evidence.note('Dropped-call recovery (P8-015): trigger is a live call drop; recovery SMS worker is telephony-originated.');
  h.evidence.note('Session cost caps: the cap is a constructor arg (not API-configurable) and unlikely to trip in a short session.');
  h.evidence.na('Documented telephony-only / non-API edge cases — exercise on a live Twilio staging environment.');
  expect(true).toBe(true);
});
