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

export async function startVoiceSession(h: RowHarness, token: string, label: string): Promise<string | undefined> {
  const res = await h.api.call({
    method: 'POST',
    path: '/api/voice/sessions',
    body: {},
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
  return (res.response.body as { proposalIds?: string[] }).proposalIds ?? [];
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
