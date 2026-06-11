/**
 * Confidence scoring is ONE input to the trust-tier decision in
 * `proposals/proposal.ts:decideInitialStatus`. That function is the
 * single place where (action class, trust tier, confidence) maps to
 * an initial proposal status — see Decision 3 in the founding decisions.
 *
 * Confidence on its own does NOT auto-approve. Auto-approval requires
 * all three of:
 *   - the calling agent declares `sourceTrustTier === 'autonomous'`
 *   - the proposal type belongs to the `'capture'` action class
 *   - the confidence score is ≥ 0.9
 *
 * Money-moving and irreversible actions never auto-approve regardless
 * of confidence. The MCP money_server
 * (service-os-agent/mcp_servers/money_server.py) provides a second
 * gate at the tool layer for money-moving actions.
 *
 * The functions below produce confidence metadata + display labels.
 * They are pure observers — neither this file nor any caller of these
 * functions should set proposal status directly.
 */

export interface ConfidenceMetadata {
  score: number; // 0-1
  factors: string[];
  model?: string;
  assessedAt: Date;
}

/**
 * The single confidence vocabulary (RV-007 / F-4). Carried from AI
 * classification into proposal payload `_meta` and rendered in
 * UI/SMS/voice. Runtime array + derived type so Zod contracts can
 * reuse it without defining a parallel enum.
 */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'very_low'] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export function validateConfidenceScore(score: number): boolean {
  return typeof score === 'number' && !isNaN(score) && score >= 0 && score <= 1;
}

export function getConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  if (score >= 0.3) return 'low';
  return 'very_low';
}

export function assessConfidence(aiOutput: Record<string, unknown>): ConfidenceMetadata {
  const rawScore = aiOutput.confidence_score;
  const score = typeof rawScore === 'number' && validateConfidenceScore(rawScore) ? rawScore : 0.5;

  const factors: string[] = [];

  // Assess output completeness based on number of fields present
  const fieldCount = Object.keys(aiOutput).length;
  if (fieldCount >= 5) {
    factors.push('high_field_coverage');
  } else if (fieldCount >= 2) {
    factors.push('partial_field_coverage');
  } else {
    factors.push('low_field_coverage');
  }

  // Check for presence of key output indicators
  if (aiOutput.confidence_score !== undefined) {
    factors.push('model_provided_confidence');
  }
  if (aiOutput.explanation) {
    factors.push('explanation_present');
  }
  if (aiOutput.payload) {
    factors.push('payload_present');
  }

  const model = typeof aiOutput.model === 'string' ? aiOutput.model : undefined;

  return {
    score,
    factors,
    model,
    assessedAt: new Date(),
  };
}

export function formatConfidenceForDisplay(metadata: ConfidenceMetadata): {
  level: ConfidenceLevel;
  label: string;
  description: string;
} {
  const level = getConfidenceLevel(metadata.score);

  const labels: Record<ConfidenceLevel, string> = {
    high: 'High Confidence',
    medium: 'Medium Confidence',
    low: 'Low Confidence',
    very_low: 'Very Low Confidence',
  };

  const descriptions: Record<ConfidenceLevel, string> = {
    high: `AI is highly confident in this suggestion (${(metadata.score * 100).toFixed(0)}%). Factors: ${metadata.factors.join(', ')}.`,
    medium: `AI has moderate confidence in this suggestion (${(metadata.score * 100).toFixed(0)}%). Factors: ${metadata.factors.join(', ')}.`,
    low: `AI has low confidence in this suggestion (${(metadata.score * 100).toFixed(0)}%). Factors: ${metadata.factors.join(', ')}.`,
    very_low: `AI has very low confidence in this suggestion (${(metadata.score * 100).toFixed(0)}%). Factors: ${metadata.factors.join(', ')}.`,
  };

  return {
    level,
    label: labels[level],
    description: descriptions[level],
  };
}
