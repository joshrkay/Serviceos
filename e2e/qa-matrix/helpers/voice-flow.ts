import type { RowHarness } from './matrix-test';

/**
 * Shared helper for the AI-voice path: start an in-app voice session, submit an
 * utterance, and (for mutations) approve the resulting proposal then wait for
 * the execution worker to run it past the 5s undo window.
 *
 * "Real LLM only" QA mode: callers treat an empty proposal list as a hard
 * failure (AI_PROVIDER_API_KEY missing / classifier miss).
 */

const apiBase = (): string => process.env.E2E_API_URL!.replace(/\/$/, '');

export interface ProposalOutcome {
  /**
   * Final proposal status, or `approve_rejected` when the approve call itself
   * was refused (e.g. 400 "Cannot approve proposal with unfilled required
   * fields") — in that case nothing can ever execute, so we do not poll.
   */
  status: string;
  resultEntityId?: string;
  proposalType?: string;
  /** Set only when status === 'approve_rejected'. */
  rejection?: { httpStatus: number; message: string; missingFields?: string[] };
}

export async function startVoiceSession(
  h: RowHarness,
  token: string,
  label: string,
  callerPhone?: string
): Promise<string | undefined> {
  const res = await h.api.call({
    method: 'POST',
    path: '/api/voice/sessions',
    body: callerPhone ? { callerPhone } : {},
    token,
    label: `${label}-vstart`,
    expectStatus: [200, 201, 400, 403, 404],
  });
  if (![200, 201].includes(res.response.status)) return undefined;
  return (res.response.body as { sessionId?: string }).sessionId;
}

export interface VoiceInputOptions {
  /**
   * The record id this row means. When the turn comes back as an entity
   * disambiguation question and this id is among the candidates, the helper
   * answers with that candidate's name.
   */
  pickCandidateId?: string;
}

interface VoiceTurnBody {
  proposalIds?: string[];
  state?: string;
  sideEffects?: Array<{ type?: string; payload?: { candidates?: Array<{ id?: string; name?: string }> } }>;
}

function disambiguationCandidates(body: VoiceTurnBody): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  for (const effect of body.sideEffects ?? []) {
    for (const c of effect.payload?.candidates ?? []) {
      if (typeof c.id === 'string' && typeof c.name === 'string') out.push({ id: c.id, name: c.name });
    }
  }
  return out;
}

export async function voiceInput(
  h: RowHarness,
  token: string,
  sessionId: string,
  text: string,
  label: string,
  opts: VoiceInputOptions = {}
): Promise<string[]> {
  const res = await h.api.call({
    method: 'POST',
    path: `/api/voice/sessions/${sessionId}/input`,
    body: { text },
    token,
    label: `${label}-vinput`,
    expectStatus: [200, 400, 403, 404],
  });
  let body = res.response.body as VoiceTurnBody;
  const proposalIds = body.proposalIds ?? [];
  if (proposalIds.length > 0) return proposalIds;

  // QA-2026-09-26 (VOX-05/VOX-07) — "the QA Matrix job" names the fixture
  // customer AND the VOX-13 ambiguous pair (all qa-matrix-A-*, score 1.0), so
  // the product correctly asks "which one?" (D-029) instead of drafting. When
  // the row knows which record it means, answer the question the way an
  // operator would — by the candidate's own name — and only if that record is
  // actually one of the offered candidates (never a guess).
  if (body.state === 'entity_resolution' && opts.pickCandidateId) {
    const pick = disambiguationCandidates(body).find((c) => c.id === opts.pickCandidateId);
    if (pick) {
      h.evidence.note(`Answered disambiguation with "${pick.name}" (expected record ${pick.id}).`);
      const pickRes = await h.api.call({
        method: 'POST',
        path: `/api/voice/sessions/${sessionId}/input`,
        body: { text: pick.name },
        token,
        label: `${label}-vinput-disambiguate`,
        expectStatus: [200, 400, 403, 404],
      });
      body = pickRes.response.body as VoiceTurnBody;
      const pickedIds = body.proposalIds ?? [];
      if (pickedIds.length > 0) return pickedIds;
    }
  }

  // A free-text entity reference that lands in the middle confidence band
  // (τ_ent_confirm_low <= score < τ_ent) surfaces an `entity_confirm` HITL
  // readback turn — "I found a job 'X' — is that the one you mean?" — before
  // the FSM ever reaches `intent_confirm`. Answer it the same way, then fall
  // through to the intent_confirm handling below (packages/api/src/ai/agents/
  // customer-calling/transitions.ts: entity_confirm -> intent_confirm on an
  // affirmative reply).
  if (body.state === 'entity_confirm') {
    const entityConfirmRes = await h.api.call({
      method: 'POST',
      path: `/api/voice/sessions/${sessionId}/input`,
      body: { text: "Yes, that's correct." },
      token,
      label: `${label}-vinput-entity-confirm`,
      expectStatus: [200, 400, 403, 404],
    });
    const entityConfirmBody = entityConfirmRes.response.body as { proposalIds?: string[]; state?: string };
    const entityConfirmProposalIds = entityConfirmBody.proposalIds ?? [];
    if (entityConfirmProposalIds.length > 0) return entityConfirmProposalIds;
    if (entityConfirmBody.state !== 'intent_confirm') return entityConfirmProposalIds;
    // Fall through with the post-entity_confirm response body so the
    // intent_confirm handling below completes the second HITL turn.
    body.state = entityConfirmBody.state;
  }

  // Non-emergency intents land in `intent_confirm` first (a deliberate HITL
  // readback turn — "...is that right?") and only create the proposal after
  // an explicit yes on the NEXT turn (packages/api/src/ai/agents/customer-calling/
  // transitions.ts: intent_confirm -> proposal_draft on confirmation). A single
  // utterance never produces a proposal for these intents — treating that as
  // "AI pipeline broken" was a QA-harness bug, not a product one. Complete the
  // confirmation turn here so the row exercises the real multi-turn flow.
  if (body.state === 'intent_confirm') {
    const confirmRes = await h.api.call({
      method: 'POST',
      path: `/api/voice/sessions/${sessionId}/input`,
      body: { text: "Yes, that's correct." },
      token,
      label: `${label}-vinput-confirm`,
      expectStatus: [200, 400, 403, 404],
    });
    return (confirmRes.response.body as { proposalIds?: string[] }).proposalIds ?? [];
  }
  return proposalIds;
}

export async function approveAndAwaitExecution(
  h: RowHarness,
  token: string,
  proposalId: string,
  label: string
): Promise<ProposalOutcome> {
  const approve = await h.api.call({
    method: 'POST',
    path: `/api/proposals/${proposalId}/approve`,
    body: {},
    token,
    label: `${label}-approve`,
    expectStatus: [200, 400, 409],
  });

  // QA-2026-09-26 — a refused approve (400 unfilled required fields, 409
  // wrong state) can never lead to execution. Polling 15×2s for it anyway
  // ran the row into Playwright's 30s test timeout, so the row wrote no
  // manifest and serial mode skipped every later row in the file
  // (AST-04 → AST-05/06/07, SCH-02 → SCH-03, SMS-01 → SMS-02).
  if (approve.response.status >= 400) {
    const body = (approve.response.body ?? {}) as {
      message?: string;
      error?: string;
      details?: { missingFields?: string[] };
    };
    const missingFields = body.details?.missingFields;
    return {
      status: 'approve_rejected',
      rejection: {
        httpStatus: approve.response.status,
        message: body.message ?? body.error ?? `HTTP ${approve.response.status}`,
        ...(missingFields ? { missingFields } : {}),
      },
    };
  }

  // Poll silently past the undo window for the execution worker.
  let status = 'pending';
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${apiBase()}/api/proposals/${proposalId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        status = ((await res.json()) as { status?: string }).status ?? status;
        if (status === 'executed' || status === 'execution_failed') break;
      }
    } catch {
      /* keep polling */
    }
  }

  // Capture the final proposal state as evidence.
  const final = await h.api.call({
    method: 'GET',
    path: `/api/proposals/${proposalId}`,
    token,
    label: `${label}-final`,
    expectStatus: [200, 404],
  });
  const body = final.response.body as {
    status?: string;
    resultEntityId?: string;
    result_entity_id?: string;
    proposalType?: string;
    proposal_type?: string;
  };
  return {
    status: body.status ?? status,
    resultEntityId: body.resultEntityId ?? body.result_entity_id,
    proposalType: body.proposalType ?? body.proposal_type,
  };
}

/** Zone the matrix assigns a tenant that has never chosen one. */
export const MATRIX_TENANT_TIMEZONE = 'America/New_York';

/**
 * QA-2026-09-26 (SCH-02 / SMS-01) — voice booking resolves "next Tuesday at
 * 2 PM" ONLY in the tenant's own zone; a tenant that never chose a zone gets a
 * draft gated on scheduledStart/scheduledEnd, by design (migration 263 dropped
 * the ET default; entity-resolution.ts resolveSpokenWindow). Dev tenant A's
 * settings row was re-created on 2026-09-19 with no zone, so every voice
 * booking row stalled on an unapprovable card. Rows that book by voice state
 * this precondition explicitly, through the same settings API an owner uses.
 */
export async function ensureTenantTimezone(h: RowHarness, token: string, label: string): Promise<string> {
  const current = await h.api.call({
    method: 'GET',
    path: '/api/settings',
    token,
    label: `${label}-settings`,
    expectStatus: 200,
  });
  const zone = (current.response.body as { timezone?: string | null } | null)?.timezone;
  if (typeof zone === 'string' && zone.length > 0) return zone;

  h.evidence.note(`Tenant had no timezone; set ${MATRIX_TENANT_TIMEZONE} via PUT /api/settings (booking precondition).`);
  await h.api.call({
    method: 'PUT',
    path: '/api/settings',
    body: { timezone: MATRIX_TENANT_TIMEZONE },
    token,
    label: `${label}-settings-timezone`,
    expectStatus: 200,
  });
  return MATRIX_TENANT_TIMEZONE;
}
