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
  status: string;
  resultEntityId?: string;
  proposalType?: string;
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

export async function voiceInput(
  h: RowHarness,
  token: string,
  sessionId: string,
  text: string,
  label: string
): Promise<string[]> {
  const res = await h.api.call({
    method: 'POST',
    path: `/api/voice/sessions/${sessionId}/input`,
    body: { text },
    token,
    label: `${label}-vinput`,
    expectStatus: [200, 400, 403, 404],
  });
  const body = res.response.body as { proposalIds?: string[]; state?: string };
  const proposalIds = body.proposalIds ?? [];
  if (proposalIds.length > 0) return proposalIds;

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
  await h.api.call({
    method: 'POST',
    path: `/api/proposals/${proposalId}/approve`,
    body: {},
    token,
    label: `${label}-approve`,
    expectStatus: [200, 400, 409],
  });

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
