import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';
import { startVoiceSession } from './helpers/voice-flow';
import { rwAvailable, rwExec } from './helpers/rw-db';
import {
  LANGUAGE_SWITCH_ACK,
  SENTENCE_CATALOG_ES,
  renderTtsText,
} from '../../packages/api/src/ai/agents/customer-calling/tts-copy';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * VOX-02 language oracle — derived from the SHIPPED es copy, not a word list.
 *
 * `ttsText` is always `renderTtsText(lastTtsPlay)` (inapp-adapter.ts), so a
 * correct Spanish turn is either an exact sentence from SENTENCE_CATALOG_ES /
 * LANGUAGE_SWITCH_ACK, or one of the interpolating templates rendered in es.
 * The old hand-rolled `spanishMarkers` list failed fluent, correct Spanish
 * that simply used different words (e.g. the escalation line "No pude
 * encontrar el registro al que se refiere…" — no marker, no accent).
 */
const ES_SENTENCES = [...Object.values(SENTENCE_CATALOG_ES), LANGUAGE_SWITCH_ACK.es].map(norm);

/**
 * Templates interpolate an intent label / entity summary / candidate names,
 * so no exact match exists. Render each one TWICE with different fillers and
 * keep the common prefix + suffix — that is the invariant Spanish frame.
 */
function frame(a: string, b: string): { prefix: string; suffix: string } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { prefix: a.slice(0, p), suffix: a.slice(a.length - s) };
}

const render = (key: string, payload: Record<string, unknown>) =>
  norm(renderTtsText(key, { template: key, ...payload }, 'es'));

const ES_FRAMES = [
  // "Para confirmar: usted desea <intent>. ¿Es correcto?"
  frame(
    render('intent_confirm', { intent: 'create_appointment' }),
    render('intent_confirm', { intent: 'record_payment' })
  ),
  // "Encontré un/una <kind> \"<summary>\" — ¿es a la que se refiere?"
  frame(
    render('confirm_entity', { entityKind: 'job', summary: 'Aaa' }),
    render('confirm_entity', { entityKind: 'invoice', summary: 'Bbb' })
  ),
  // "Encontré varias coincidencias — ¿se refiere a X o Y? ¿Cuál de ellas?"
  frame(
    render('disambiguate', { candidates: [{ name: 'Aaa' }, { name: 'Bbb' }] }),
    render('disambiguate', { candidates: [{ name: 'Ccc' }, { name: 'Ddd' }] })
  ),
].filter((f) => f.prefix.length + f.suffix.length >= 12);

const ES_FIXED_TEMPLATES = [
  render('greeting', {}),
  render('greeting_with_disclosure', {}),
  // The "identical candidate names" branch of the disambiguation renderer.
  render('disambiguate', { candidates: [{ name: 'Aaa' }, { name: 'Aaa' }] }),
];

/** True when `tts` is a rendered-in-Spanish line from the shipped es copy. */
function isSpanishCopy(tts: string): boolean {
  const t = norm(tts);
  if (!t) return false;
  if (ES_SENTENCES.includes(t) || ES_FIXED_TEMPLATES.includes(t)) return true;
  return ES_FRAMES.some((f) => t.startsWith(f.prefix) && t.endsWith(f.suffix));
}

/**
 * VOX-01 — emergency triage fast-path (voice; real LLM).
 * VOX-02 — Spanish / i18n voice response (real LLM, soft language check).
 * VOX-03 — DNC suppression of outbound SMS (RW-seeded DNC entry).
 * VOX-04 — documents the telephony-only cases not drivable in simulated mode.
 * VOX-12 — callerPhone with no matching customer: regression guard (unresolved, unchanged).
 * VOX-13 — callerPhone matching two customers: regression guard (unresolved, no guessing).
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
    h.evidence.fail('Voice responded but no clear emergency/escalation signal in the turn — review captured response.');
  }
});

matrixTest('VOX-02', 'Spanish / i18n voice response', async (h) => {
  // Spanish auto-detection is gated on the tenant's opt-in language stack
  // (packages/api/src/ai/agents/customer-calling/inapp-adapter.ts, "Voice-
  // parity (Feature 6)" — deliberate: without the gate, ANY caller uttering
  // Spanish words would flip the whole call to Spanish regardless of the
  // tenant's Settings toggle). Fresh QA tenants default to
  // tenant_settings.supported_languages = {en} (see schema default), so a
  // Spanish utterance is correctly ignored until the tenant opts in — that
  // is the product working as designed, not a bug. Opt in here first so this
  // row actually exercises the Spanish-response path.
  await h.api.call({
    method: 'PATCH',
    path: '/api/settings/language',
    body: { supportedLanguages: ['en', 'es'] },
    token: h.tenantA.token,
    label: '02-enable-es',
    expectStatus: [200, 201],
  });

  const sessionId = await startVoiceSession(h, h.tenantA.token, '02');
  if (!sessionId) return void h.evidence.fail('Voice session could not be started.');

  const res = await submit(
    h,
    sessionId,
    'Hola, necesito ayuda con mi aire acondicionado que no enfría y quisiera agendar una visita por favor',
    '02-input'
  );
  if (res.response.status !== 200) {
    return void h.evidence.fail(`Voice input returned ${res.response.status}; cannot assess language handling.`);
  }
  const tts = ((res.response.body as { ttsText?: string }).ttsText ?? '').toLowerCase();
  // Catalog-derived oracle: the turn's ttsText is renderTtsText() output, so
  // ANY correct Spanish response is a line from the shipped es copy —
  // whichever template happens to fire. Accented characters / inverted
  // punctuation stay as a secondary signal so es copy added to the FSM
  // without a catalog entry still reads as Spanish rather than failing.
  const looksSpanish = isSpanishCopy(tts) || /[¿¡ñáéíóú]/.test(tts);
  if (tts && looksSpanish) {
    h.evidence.pass('Voice responded in Spanish to a Spanish utterance.');
  } else {
    h.evidence.fail(`Response captured but Spanish not clearly detected (ttsText="${tts.slice(0, 80)}").`);
  }
});

matrixTest('VOX-03', 'DNC suppression of outbound SMS', async (h) => {
  if (!rwAvailable()) {
    h.evidence.fail('E2E_DB_URL_READWRITE not set — cannot seed a DNC entry (required for voice DNC gate).');
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
    h.evidence.fail(`Could not seed DNC (schema differs?): ${(err as Error).message}`);
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
    h.evidence.fail(`Estimate send returned ${send.response.status}; DNC path not exercised.`);
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

matrixTest('VOX-12', 'callerPhone with no matching customer falls through unchanged', async (h) => {
  // QA-2026-07-26 — regression guard for the callerPhone resolution added to
  // InAppVoiceAdapter.startSession (packages/api/src/ai/agents/customer-calling/
  // inapp-adapter.ts). A phone that matches no tenant customer must leave the
  // caller unresolved — same as before the fix — so "our customer" (a
  // GENERIC_CUSTOMER_REFS phrase that skips name-based lookup entirely) still
  // fails to produce a proposal. Not seeded anywhere; guaranteed to miss.
  const noMatchPhone = '555-0399';
  const sessionId = await startVoiceSession(h, h.tenantA.token, '12', noMatchPhone);
  if (!sessionId) return void h.evidence.fail('Voice session could not be started.');

  const res = await submit(
    h,
    sessionId,
    'Schedule a furnace tune-up for our customer next Tuesday at 2 PM',
    '12-input'
  );
  if (res.response.status !== 200) {
    return void h.evidence.fail(`Voice input returned ${res.response.status}; AI pipeline not ready (Real-LLM-only).`);
  }
  const proposalIds = (res.response.body as { proposalIds?: string[] }).proposalIds ?? [];
  if (proposalIds.length === 0) {
    h.evidence.pass('No callerPhone match — caller left unresolved; "our customer" still failed to resolve (unchanged fallback).');
  } else {
    h.evidence.fail('A generic "our customer" utterance produced a proposal despite an unmatched callerPhone — unexpected guess.');
  }
});

matrixTest('VOX-13', 'callerPhone matching two customers falls through unchanged', async (h) => {
  // QA-2026-07-26 — companion regression guard: a callerPhone matching TWO
  // customers on the same tenant (seeded by fixtures/seed.ts as
  // `${slug}-ambiguous-1` / `${slug}-ambiguous-2`, both on '555-0200', kept
  // distinct from the primary customer's '555-0100' used by SCH-02/SMS-01)
  // must also leave the caller unresolved — the adapter never guesses among
  // ambiguous matches (0 or 2+ matches take the same unresolved branch).
  const ambiguousPhone = '555-0200';
  const sessionId = await startVoiceSession(h, h.tenantA.token, '13', ambiguousPhone);
  if (!sessionId) return void h.evidence.fail('Voice session could not be started.');

  const res = await submit(
    h,
    sessionId,
    'Schedule a furnace tune-up for our customer next Tuesday at 2 PM',
    '13-input'
  );
  if (res.response.status !== 200) {
    return void h.evidence.fail(`Voice input returned ${res.response.status}; AI pipeline not ready (Real-LLM-only).`);
  }
  const proposalIds = (res.response.body as { proposalIds?: string[] }).proposalIds ?? [];
  if (proposalIds.length === 0) {
    h.evidence.pass('Ambiguous callerPhone (2 matches) — caller left unresolved; "our customer" still failed to resolve (no guessing).');
  } else {
    h.evidence.fail('A generic "our customer" utterance produced a proposal despite an ambiguous callerPhone match — unexpected guess.');
  }
});
