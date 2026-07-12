import type { KnownEntities } from '../ai/training/scrub';
import { scrubPii } from '../ai/training/scrub';
import {
  PRESIDIO_UNAVAILABLE_SIGNAL,
  PresidioUnavailableError,
  type PresidioAnonymizer,
} from '../ai/privacy/presidio-adapter';
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
  /**
   * True only when the result is a FAIL-CLOSED quarantine caused by the
   * Presidio backend being unavailable (or unconfigured while required).
   * Distinct from an ordinary residual-PII quarantine: it means we never
   * completed a trusted redaction pass, so the caller must not persist any
   * derived text and should short-circuit the remaining fields.
   */
  failClosed?: boolean;
}

export interface TrainingAssetRedactionServiceOptions {
  /**
   * Optional Presidio adapter. When present, `redactAsync` runs a Presidio
   * pass FIRST and fails closed (quarantine) if it is unavailable. When
   * absent, `redactAsync` behaves exactly like the synchronous `redact`
   * (local deterministic scrub only) — the dev/test default.
   */
  presidio?: PresidioAnonymizer;
  /**
   * When true and no `presidio` adapter is configured, `redactAsync` fails
   * closed on every call (treats "unconfigured" as "unavailable"). Lets a
   * deployment demand Presidio-backed redaction without silently degrading to
   * regex-only. Defaults to false so local-only mode stays the default.
   */
  presidioRequired?: boolean;
}

export class TrainingAssetRedactionService {
  private readonly presidio?: PresidioAnonymizer;
  private readonly presidioRequired: boolean;

  constructor(options: TrainingAssetRedactionServiceOptions = {}) {
    this.presidio = options.presidio;
    this.presidioRequired = options.presidioRequired ?? false;
  }

  /** Whether a Presidio pass will actually run for `redactAsync`. */
  get presidioEnabled(): boolean {
    return Boolean(this.presidio) || this.presidioRequired;
  }

  /**
   * Synchronous, LOCAL-ONLY redaction: the deterministic `scrubPii` sweep plus
   * the residual-PII gate. No model/network calls. Preserved verbatim for the
   * many call sites and tests that depend on a pure, synchronous contract.
   */
  redact(input: TrainingAssetRedactionInput): TrainingAssetRedactionResult {
    return this.finishLocal(input.text, input.knownEntities);
  }

  /**
   * Presidio-first redaction with the local sweep as defense in depth.
   *
   * Pipeline:
   *   1. Presidio Analyzer + Anonymizer replace detected PII spans.
   *   2. The deterministic `scrubPii` (known-entity + regex) sweep runs over
   *      Presidio's output — catching anything Presidio's recognizers miss.
   *   3. The residual-PII gate makes the final embed/quarantine decision.
   *
   * FAIL CLOSED: if Presidio is unavailable (or unconfigured while required),
   * returns a quarantine result flagged `failClosed`, carrying the
   * `presidio_unavailable` residual signal — never raw or regex-only text as
   * active.
   */
  async redactAsync(
    input: TrainingAssetRedactionInput,
  ): Promise<TrainingAssetRedactionResult> {
    if (!this.presidio) {
      if (this.presidioRequired) {
        return this.failClosedResult();
      }
      // Local-only mode (dev/test default) — identical to the sync path.
      return this.finishLocal(input.text, input.knownEntities);
    }

    let presidioText: string;
    try {
      const result = await this.presidio.anonymize(input.text);
      presidioText = result.anonymizedText;
    } catch (err) {
      if (err instanceof PresidioUnavailableError) {
        return this.failClosedResult();
      }
      // Any unexpected error is still an unavailability we must fail closed on.
      return this.failClosedResult();
    }

    // Defense in depth: run the deterministic sweep over Presidio's output.
    return this.finishLocal(presidioText, input.knownEntities);
  }

  /** Run the deterministic scrub + residual gate and shape the result. */
  private finishLocal(
    text: string,
    knownEntities?: KnownEntities,
  ): TrainingAssetRedactionResult {
    const scrubbed = scrubPii(text, { knownEntities, failOnResidual: false });
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

  /**
   * A fail-closed quarantine result. Carries NO derived text (empty
   * `scrubbedText`) and records the reason as a residual signal so it lands in
   * the privacy_audit entry.
   */
  private failClosedResult(): TrainingAssetRedactionResult {
    return {
      status: 'quarantined',
      scrubbedText: '',
      summary: {
        redactionCount: 0,
        redactionKinds: [],
        placeholders: [],
        residualSignals: [PRESIDIO_UNAVAILABLE_SIGNAL],
        hasResidualPii: true,
      },
      auditRedactions: [],
      failClosed: true,
    };
  }
}
