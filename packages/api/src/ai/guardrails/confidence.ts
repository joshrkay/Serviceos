/**
 * IMPORTANT: Confidence is advisory only.
 * These functions NEVER trigger auto-approval or auto-execution.
 * Confidence metadata is for display and informational purposes only.
 * All proposals must still go through the standard human-review approval flow.
 */

export interface ConfidenceMetadata {
  score: number; // 0-1
  factors: string[];
  model?: string;
  assessedAt: Date;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'very_low';

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
