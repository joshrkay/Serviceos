/**
 * summarize_session skill — end-of-call structured summary.
 *
 * Runs at the end of a customer-calling session to produce a short
 * human-readable summary, surface the inferred intent, and compute a
 * quality score for analytics. Optionally persists the result to the
 * call_summaries table when a pg pool is supplied.
 *
 * Design decisions:
 * - Quality score is computed deterministically in code from structured
 *   signals (proposals, intent, escalation). The LLM only produces the
 *   prose summary. This keeps scoring auditable and avoids relying on
 *   the model for a numeric value we already have signal for.
 * - Escalation is detected from the last few transcript turns (substring
 *   scan for "escalate" / "transfer"). When detected, the score is
 *   fixed at 0.3 — partial credit for capturing the call.
 * - Gateway errors propagate (don't swallow) so the caller can decide
 *   whether to retry or fall back.
 * - DB write errors propagate too: if the caller passed a pool, they
 *   want the row written; failure should surface.
 */

import type { Pool } from 'pg';
import { LLMGateway } from '../gateway/gateway';

export interface SummarizeSessionInput {
  tenantId: string;
  /** call_id in DB (voice_recordings.id). */
  sessionId: string;
  /** Ordered speaker turns, e.g. "agent: ..." / "caller: ...". */
  transcript: string[];
  proposalIds: string[];
  intentDetected?: string;
  durationMs: number;
  gateway: LLMGateway;
  /** When provided, a row is inserted into call_summaries; omit to skip persistence. */
  pool?: Pool;
}

export interface SummarizeSessionResult {
  summary: string;
  intentDetected?: string;
  proposalIds: string[];
  /** 0.0–1.0; omitted when no proposals were produced AND the session was not escalated. */
  qualityScore?: number;
}

interface ParsedSummary {
  summary: string;
}

function parseSummary(content: string): ParsedSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.summary !== 'string' || obj.summary.trim().length === 0) return null;
  return { summary: obj.summary.trim() };
}

function isEscalated(transcript: string[]): boolean {
  if (transcript.length === 0) return false;
  // Escalation cues land near the end; scan the last few turns only.
  const tail = transcript.slice(-3).join(' ').toLowerCase();
  return tail.includes('escalate') || tail.includes('transfer');
}

function computeQualityScore(args: {
  hasProposals: boolean;
  hasIntent: boolean;
  escalated: boolean;
}): number | undefined {
  if (args.escalated) return 0.3;
  if (!args.hasProposals) return undefined;
  let score = 0.5;
  if (args.hasIntent) score += 0.25;
  // No reliable signal in current inputs for "caller-confirmed proposal";
  // the remaining +0.25 is intentionally left out and can be wired in
  // when confirm_intent results are threaded through here.
  return Math.min(1, Math.max(0, score));
}

export async function summarizeSession(
  input: SummarizeSessionInput
): Promise<SummarizeSessionResult> {
  const {
    tenantId,
    sessionId,
    transcript,
    proposalIds,
    intentDetected,
    durationMs,
    gateway,
    pool,
  } = input;

  const escalated = isEscalated(transcript);
  const qualityScore = computeQualityScore({
    hasProposals: proposalIds.length > 0,
    hasIntent: Boolean(intentDetected && intentDetected.trim().length > 0),
    escalated,
  });

  const transcriptBlock = transcript.length > 0
    ? transcript.join('\n')
    : '(empty transcript)';

  const prompt = `Summarize the following customer service call in 3 sentences or fewer.
Focus on what the caller wanted, what was decided, and any next steps.
Do not include personally identifiable information beyond what is needed for context.

Duration: ${Math.round(durationMs / 1000)}s
Detected intent: ${intentDetected ?? '(none)'}
Proposals produced: ${proposalIds.length}
Escalated to human: ${escalated ? 'yes' : 'no'}

Transcript:
${transcriptBlock}

Return JSON: { "summary": "..." }
- summary: <= 3 sentences, plain prose, no markdown.`;

  // Throws on timeout / provider error — callers handle retry.
  const response = await gateway.complete({
    taskType: 'summarize_conversation',
    messages: [{ role: 'user', content: prompt }],
    responseFormat: 'json',
    temperature: 0.2,
    metadata: { tenantId, skill: 'summarize_session', sessionId },
  });

  const parsed = parseSummary(response.content);
  // Fall back to a deterministic stub if the model returns something unparseable.
  const summary = parsed?.summary ?? 'Call completed; no structured summary available.';

  if (pool) {
    await pool.query(
      `INSERT INTO call_summaries
         (tenant_id, call_id, summary, detected_intent, proposal_ids, quality_score)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        sessionId,
        summary,
        intentDetected ?? null,
        proposalIds,
        qualityScore ?? null,
      ]
    );
  }

  const result: SummarizeSessionResult = {
    summary,
    proposalIds,
  };
  if (intentDetected !== undefined) result.intentDetected = intentDetected;
  if (qualityScore !== undefined) result.qualityScore = qualityScore;
  return result;
}
