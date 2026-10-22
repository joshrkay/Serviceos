/**
 * #1736 — drain the owners' pending call corrections into the corpus.
 *
 * For each tenant, every correction not yet exported is rebuilt against the
 * call's stored transcript (`buildCorrectionCase`, caller lines only,
 * PII-redacted), written as a script + golden + placeholder cassette
 * (`writeCorrectionCase`), and stamped exported. A correction that cannot be
 * built (call gone, no caller turns) is reported and left pending — it never
 * blocks its siblings. Run by `scripts/export-call-corrections.ts`; the
 * resulting files are reviewed and committed by a human, then recorded with
 * `npm run voice-quality:record`.
 */
import { pairTranscriptTurns } from '../../../voice/quality/transcript-observation';
import type { VoiceSessionGradeStore } from '../../../voice/quality/voice-session-grade-store';
import type { CallScoreStore } from '../../../voice/scoring/call-score-store';
import { buildCorrectionCase, writeCorrectionCase } from './correction-case';

export interface ExportCorrectionsDeps {
  store: Pick<CallScoreStore, 'listPendingExport' | 'markExported'>;
  sessions: Pick<VoiceSessionGradeStore, 'loadSession'>;
  corpusRoot: string;
  now?: () => Date;
}

export interface ExportCorrectionsResult {
  exported: Array<{ tenantId: string; correctionId: string; scriptId: string; files: string[] }>;
  failed: Array<{ tenantId: string; correctionId: string; reason: string }>;
}

export async function exportPendingCorrections(
  tenantIds: readonly string[],
  deps: ExportCorrectionsDeps,
): Promise<ExportCorrectionsResult> {
  const now = deps.now ?? (() => new Date());
  const result: ExportCorrectionsResult = { exported: [], failed: [] };
  for (const tenantId of tenantIds) {
    for (const correction of await deps.store.listPendingExport(tenantId)) {
      try {
        const session = await deps.sessions.loadSession(tenantId, correction.sessionId);
        if (!session) throw new Error('call no longer exists');
        const callerTurns = pairTranscriptTurns(session.transcript).map((t) => t.caller);
        const built = buildCorrectionCase(correction, callerTurns);
        const files = writeCorrectionCase(built, deps.corpusRoot);
        await deps.store.markExported(tenantId, correction.id, built.scriptId, now());
        result.exported.push({ tenantId, correctionId: correction.id, scriptId: built.scriptId, files });
      } catch (err) {
        result.failed.push({
          tenantId,
          correctionId: correction.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}
