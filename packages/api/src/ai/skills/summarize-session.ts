/**
 * summarize_session skill — LLM summary + quality score at session end.
 *
 * Produces a structured plain-English summary of a completed call session,
 * computes a server-side quality score, and optionally persists the result
 * to the call_summaries table.
 *
 * Design decisions:
 * - Quality score is computed server-side from measurable session outcomes,
 *   not inferred from LLM output. The LLM only provides the summary text.
 * - Graceful degradation: LLM failure falls back to a duration-based summary.
 *   summarizeSession never throws — callers can rely on always getting a result.
 * - DB write is optional (pool parameter). When omitted, no write occurs.
 * - taskType 'summarize' routes to Claude Haiku via gateway routing config.
 */

import type { LLMGateway } from '../gateway/gateway';
import type { Pool } from 'pg';
import { setTenantContext } from '../../db/schema';

export interface SummarizeSessionInput {
  tenantId: string;
  sessionId: string;
  /** Ordered array of speaker turns, e.g. ["Caller: I need...", "Agent: I can help..."] */
  transcript: string[];
  /** Proposal IDs created during the session. */
  proposalIds: string[];
  /** Final classified intent, e.g. 'create_appointment'. */
  intentDetected?: string;
  /** Session duration in milliseconds. */
  durationMs: number;
  /** True if session ended in escalation to a human agent. */
  escalated?: boolean;
  gateway: LLMGateway;
  /** When provided, the summary is written to the call_summaries table. */
  pool?: Pool;
  /** Existing call_summaries row ID to update (optional — unused in INSERT path). */
  callSummaryId?: string;
}

export interface SummarizeSessionResult {
  /** 1–3 sentence plain-English call summary. */
  summary: string;
  intentDetected?: string;
  proposalIds: string[];
  /** 0.00–1.00; present when session had measurable outcomes. Undefined for empty transcripts. */
  qualityScore?: number;
  /** ID of the call_summaries row written (only present when pool was provided). */
  callSummaryId?: string;
}

/**
 * Compute a quality score from observable session outcomes.
 *
 * Rubric (server-side, independent of LLM):
 *   +0.50 — at least one proposal was created
 *   +0.25 — intent was detected and not 'unknown'
 *   +0.25 — session resolved without escalation
 *   Cap: 1.0
 *
 * Returns undefined when the transcript is empty (no data to score).
 */
function computeQualityScore(
  transcript: string[],
  proposalIds: string[],
  intentDetected: string | undefined,
  escalated: boolean | undefined
): number | undefined {
  if (transcript.length === 0) return undefined;

  let score = 0;

  if (proposalIds.length > 0) score += 0.5;
  if (intentDetected && intentDetected !== 'unknown') score += 0.25;
  if (!escalated) score += 0.25;

  return Math.min(score, 1.0);
}

/** Parse the LLM JSON response and extract the summary string. Returns null on any failure. */
function parseLLMSummary(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.summary !== 'string' || obj.summary.trim() === '') return null;
  return obj.summary;
}

export async function summarizeSession(
  input: SummarizeSessionInput
): Promise<SummarizeSessionResult> {
  const {
    tenantId,
    proposalIds,
    intentDetected,
    durationMs,
    escalated,
    transcript,
    gateway,
    pool,
  } = input;

  const qualityScore = computeQualityScore(transcript, proposalIds, intentDetected, escalated);

  const fallbackSummary = `Call lasted ${Math.round(durationMs / 1000)}s. ${proposalIds.length} proposal(s) created.`;

  let summary: string;

  try {
    const transcriptText =
      transcript.length > 0
        ? transcript.join('\n')
        : '(no transcript available)';

    const userMessage = [
      `Transcript:\n${transcriptText}`,
      `Duration: ${Math.round(durationMs / 1000)}s`,
      intentDetected ? `Detected intent: ${intentDetected}` : null,
      `Proposals created: ${proposalIds.length}`,
      escalated ? 'Session ended in escalation.' : 'Session resolved without escalation.',
    ]
      .filter(Boolean)
      .join('\n');

    const response = await gateway.complete({
      taskType: 'summarize',
      messages: [
        {
          role: 'system',
          content:
            'You are a call summary assistant for a home services company. Summarize the call transcript in 1-3 sentences and score the call quality. Respond with JSON: { summary: string, qualityScore: number | null }. qualityScore is 0.0-1.0 or null if there is insufficient data.',
        },
        {
          role: 'user',
          content: userMessage,
        },
      ],
      responseFormat: 'json',
      temperature: 0,
      metadata: { tenantId, skill: 'summarize_session' },
    });

    const parsed = parseLLMSummary(response.content);
    summary = parsed ?? fallbackSummary;
  } catch {
    summary = fallbackSummary;
  }

  let callSummaryId: string | undefined;

  if (pool) {
    try {
      const client = await pool.connect();
      try {
        await client.query(setTenantContext(tenantId));
        const result = await client.query<{ id: string }>(
          `INSERT INTO call_summaries (tenant_id, summary, detected_intent, proposal_ids, quality_score)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            tenantId,
            summary,
            intentDetected ?? null,
            proposalIds,
            qualityScore ?? null,
          ]
        );
        callSummaryId = result.rows[0]?.id;
      } finally {
        client.release();
      }
    } catch {
      // DB write failure is non-fatal — summary is still returned to caller.
    }
  }

  return {
    summary,
    ...(intentDetected !== undefined ? { intentDetected } : {}),
    proposalIds,
    ...(qualityScore !== undefined ? { qualityScore } : {}),
    ...(callSummaryId !== undefined ? { callSummaryId } : {}),
  };
}
