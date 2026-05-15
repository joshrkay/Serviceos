import type { KnownEntities } from '../ai/training/scrub';
import { scrubPii } from '../ai/training/scrub';
import type { TrainingAssetRedactionSummary, TrainingAssetStatus } from './training-assets';

export interface TrainingAssetRedactionInput {
  text: string;
  knownEntities?: KnownEntities;
}

export interface AuditSafeRedaction {
  kind: string;
  placeholder: string;
  start: number;
  end: number;
}

export interface TrainingAssetRedactionResult {
  status: Extract<TrainingAssetStatus, 'redacted' | 'quarantined'>;
  scrubbedText: string;
  summary: TrainingAssetRedactionSummary;
  auditRedactions: AuditSafeRedaction[];
}

export class TrainingAssetRedactionService {
  redact(input: TrainingAssetRedactionInput): TrainingAssetRedactionResult {
    const scrubbed = scrubPii(input.text, {
      knownEntities: input.knownEntities,
      failOnResidual: false,
    });
    const auditRedactions = scrubbed.redactions.map((redaction) => ({
      kind: redaction.kind,
      placeholder: redaction.placeholder,
      start: redaction.start,
      end: redaction.end,
    }));
    const summary: TrainingAssetRedactionSummary = {
      redactionCount: auditRedactions.length,
      redactionKinds: [...new Set(auditRedactions.map((redaction) => redaction.kind))],
      placeholders: [...new Set(auditRedactions.map((redaction) => redaction.placeholder))],
      residualSignals: scrubbed.residualSignals,
      hasResidualPii: scrubbed.hasResidualPii,
    };

    return {
      status: scrubbed.hasResidualPii ? 'quarantined' : 'redacted',
      scrubbedText: scrubbed.scrubbed,
      summary,
      auditRedactions,
    };
  }
}
