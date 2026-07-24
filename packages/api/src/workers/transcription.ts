import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { VoiceRepository, TranscriptionProvider } from '../voice/voice-service';
import { LLMGateway } from '../ai/gateway/gateway';
import { encrypt } from '../integrations/crypto';

export interface TranscriptionJobPayload {
  tenantId: string;
  recordingId: string;
  audioUrl: string;
  conversationId?: string;
  /** Tenant-verified job context supplied by the recording route. */
  jobId?: string;
  /**
   * The user whose session produced the voice recording. Required when
   * downstream consumers (voice-action-router) need to create proposals
   * attributed to a human. Optional to preserve backward compatibility
   * with older queue messages.
   */
  userId?: string;
}

export interface TranscriptionCompletionEvent {
  tenantId: string;
  recordingId: string;
  transcript: string;
  conversationId?: string;
  userId?: string;
  jobId?: string;
}

/**
 * Supplies tenant-specific vocabulary to the transcription correction
 * pass so trade-specific terms and customer names aren't mis-heard
 * ("pex" → "pecks", "Rodriguez" → "Roderick", etc). The provider is
 * expected to return a short list (<= ~100 terms) to keep the prompt
 * cheap. Empty list is fine — correction still runs on generic terms.
 */
export interface TranscriptionGlossaryProvider {
  termsForTenant(tenantId: string): Promise<string[]>;
}



export const TRANSCRIPT_SANITIZATION_VERSION = 'v1';

/**
 * Removes control characters, normalizes whitespace/newlines, and trims
 * transcript text so downstream prompts receive a stable canonical string.
 */
export function sanitizeTranscript(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const noControlChars = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
  const normalizedNewlines = noControlChars.replace(/\r\n?/g, '\n');
  const collapsed = normalizedNewlines
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return collapsed.trim();
}

/**
 * Blocker 12 — encrypt the retained RAW transcript at rest.
 *
 * Raw transcripts are call PII. Previously they were stored base64-encoded
 * (reversible to plaintext) under a `pending-kms-integration` marker. We now
 * encrypt them with AES-256-GCM using a key from `TRANSCRIPT_ENCRYPTION_KEY`
 * (64-hex / 32 bytes), reusing the audited cipher in integrations/crypto.ts.
 *
 * Returns the retention object, or `null` when no key is configured — in
 * which case we DO NOT retain the raw transcript at all rather than store
 * plaintext. (The sanitized, operational transcript is stored separately in
 * the canonical `transcript` field; only this raw-retention blob is sensitive
 * enough to warrant encryption + a limited-access reader role.)
 */
function buildRawTranscriptRetention(
  raw: string,
  hexKey: string | undefined,
): {
  encryptedBlob: string;
  encryption: string;
  ttl: string;
  accessRole: string;
  auditLogRequired: boolean;
} | null {
  if (!hexKey) return null;
  return {
    encryptedBlob: encrypt(raw, hexKey),
    encryption: 'aes-256-gcm',
    ttl: 'P7D',
    accessRole: 'voice_transcript_raw_reader',
    auditLogRequired: true,
  };
}

export interface CreateTranscriptionWorkerOptions {
  /**
   * Fired after a successful transcription is persisted. Used to hand
   * the transcript off to the voice-action-router which enqueues a
   * downstream job. The callback failing does NOT fail the transcription —
   * the transcript is already safely stored, and router errors are
   * recoverable via retry on their own queue.
   */
  onTranscribed?: (event: TranscriptionCompletionEvent, logger: Logger) => Promise<void> | void;
  /**
   * Optional LLM gateway. When supplied, the worker runs a
   * `transcription_correction` pass after Whisper returns: the raw
   * transcript is rewritten with tenant-specific trade terms and
   * customer names in mind. The raw transcript is preserved under
   * `transcriptMetadata.rawTranscript` for debugging and audit.
   * Correction failures are non-fatal — we fall back to the raw
   * Whisper output so the pipeline keeps moving.
   */
  gateway?: LLMGateway;
  /**
   * Optional glossary source used only when `gateway` is set. When
   * omitted the correction pass runs with an empty glossary and relies
   * on the built-in trade vocabulary baked into the system prompt.
   */
  glossary?: TranscriptionGlossaryProvider;
  /**
   * Blocker 12 — AES-256-GCM key (64-hex) used to encrypt the retained raw
   * transcript at rest. The app wires this from `TRANSCRIPT_ENCRYPTION_KEY`
   * (falling back to `TENANT_ENCRYPTION_KEY`). When unset, the raw transcript
   * is not retained (no plaintext PII at rest).
   */
  rawTranscriptEncryptionKey?: string;
}

/**
 * System prompt for the transcription-correction pass. Restored from the
 * (removed) DEFAULT_GATEWAY_CONFIG, which defined this prompt for
 * `transcription_correction` but was never wired into the live gateway — so
 * the correction call had been running with no system instruction at all.
 */
const TRANSCRIPTION_CORRECTION_SYSTEM_PROMPT =
  'Correct errors in voice transcriptions for a service business context. ' +
  'Fix technical terminology, trade-specific terms, names, and numbers. ' +
  'Return corrected text only — no commentary.';

/**
 * Defense-in-depth against a misconfigured/mock gateway silently replacing
 * a prose transcript with structured output. Genuine correction of a voice
 * transcript is still prose — it should never parse as JSON unless the raw
 * input already did. Used to reject cases like a hermetic mock's scripted
 * catch-all (`{"ok":true,"mock":true,...}`) that happens to clear the
 * length-floor guard below but is obviously not a transcription.
 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort transcription correction. Calls the gateway with
 * `taskType: 'transcription_correction'`, sending the system prompt above
 * plus the tenant glossary + raw transcript as the user message. (This
 * taskType isn't in ai-routing.ts `taskTierMapping`, so it resolves to the
 * standard tier.) Returns `{ corrected, glossary }`; on ANY failure, returns
 * the raw transcript unchanged — this is a quality upgrade, not a gate.
 */
async function correctTranscript(input: {
  raw: string;
  tenantId: string;
  gateway: LLMGateway;
  glossary?: TranscriptionGlossaryProvider;
  logger: Logger;
}): Promise<{ corrected: string; glossary: string[] }> {
  const { raw, tenantId, gateway, glossary, logger } = input;
  let terms: string[] = [];
  if (glossary) {
    try {
      terms = await glossary.termsForTenant(tenantId);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn('Transcription glossary lookup failed', { error: error.message });
    }
  }

  try {
    const userPrompt =
      terms.length > 0
        ? `Tenant-specific vocabulary (preserve exactly when you hear a close match): ${terms.join(
            ', '
          )}\n\nRaw transcript: ${raw}`
        : `Raw transcript: ${raw}`;

    const response = await gateway.complete({
      taskType: 'transcription_correction',
      // Top-level tenantId — the quota/cache resilience wrappers key on
      // this, not metadata.tenantId (see gateway.ts's tenant-id guard).
      tenantId,
      messages: [
        { role: 'system', content: TRANSCRIPTION_CORRECTION_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      // transcription_correction routes to the lightweight tier (cheap model);
      // its 1024-token default can truncate the correction of a long call. Pin
      // the budget explicitly (matches the original gateway-config intent of
      // 2048) so the corrected output is never silently cut off.
      maxTokens: 2048,
      metadata: { tenantId },
    });

    const corrected = response.content.trim();

    // Defense-in-depth: reject a "corrected" result that parses as JSON
    // when the raw transcript did not. This catches ANY future
    // misconfigured/wrong gateway (e.g. a hermetic mock wired in by
    // mistake) injecting structured garbage as a transcript, independent
    // of the length-floor check below — a short JSON blob can easily clear
    // that floor for a short-to-medium raw transcript.
    if (looksLikeJson(corrected) && !looksLikeJson(raw)) {
      logger.warn(
        'Transcription correction returned JSON for prose input; keeping raw transcript',
        { rawLen: raw.length, correctedLen: corrected.length }
      );
      return { corrected: raw, glossary: terms };
    }

    // Guardrail: correction should not silently truncate. Fall back
    // to the raw transcript when the correction is either
    // proportionally too short (< 40% of raw length, catching obvious
    // model mis-interpretation on longer utterances) OR absolutely
    // too short (< MIN_CORRECTED_CHARS, catching the short-input
    // edge case where 40% of a 3-char "yes" is 1.2 chars — a 1-char
    // "y" would falsely pass the ratio check).
    const MIN_CORRECTED_CHARS = 4;
    const floor = Math.max(MIN_CORRECTED_CHARS, Math.ceil(raw.length * 0.4));
    if (corrected.length === 0 || corrected.length < floor) {
      logger.warn('Transcription correction produced suspiciously short output; keeping raw', {
        rawLen: raw.length,
        correctedLen: corrected.length,
        floor,
      });
      return { corrected: raw, glossary: terms };
    }

    return { corrected, glossary: terms };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn('Transcription correction failed; keeping raw transcript', {
      error: error.message,
    });
    return { corrected: raw, glossary: terms };
  }
}

export function createTranscriptionWorker(
  voiceRepository: VoiceRepository,
  transcriptionProvider: TranscriptionProvider,
  options: CreateTranscriptionWorkerOptions = {}
): WorkerHandler<TranscriptionJobPayload> {
  return {
    type: 'transcription',
    async handle(message: QueueMessage<TranscriptionJobPayload>, logger: Logger): Promise<void> {
      const { tenantId, recordingId, audioUrl, conversationId, userId, jobId } = message.payload;

      logger.info('Starting transcription', { recordingId, conversationId });

      await voiceRepository.updateStatus(tenantId, recordingId, 'processing');

      try {
        const result = await transcriptionProvider.transcribe(audioUrl);

        // Transcription correction pass: only runs when a gateway was
        // wired in. The raw Whisper output is kept on
        // transcriptMetadata.rawTranscript for debugging, and the
        // corrected version becomes the canonical transcript the
        // router sees. This closes the biggest quality gap: trade
        // terms and customer names that Whisper alone gets wrong.
        const providerTranscript = result.transcript ?? '';
        const sanitizedProviderTranscript = sanitizeTranscript(providerTranscript);
        let correctedTranscript = sanitizedProviderTranscript;
        let correctionMetadata: Record<string, unknown> = {};
        if (options.gateway && providerTranscript.trim().length > 0) {
          const { corrected, glossary } = await correctTranscript({
            raw: sanitizedProviderTranscript,
            tenantId,
            gateway: options.gateway,
            glossary: options.glossary,
            logger,
          });
          correctedTranscript = corrected;
          correctionMetadata = {
            correctionApplied: corrected !== sanitizedProviderTranscript,
            glossaryTerms: glossary.length,
          };
        }

        const sanitizedTranscript = sanitizeTranscript(correctedTranscript);

        await voiceRepository.updateStatus(tenantId, recordingId, 'completed', {
          transcript: sanitizedTranscript,
          metadata: {
            ...result.metadata,
            ...correctionMetadata,
            sanitization_version: TRANSCRIPT_SANITIZATION_VERSION,
            canonical_transcript_field: 'transcript',
            prompt_rehydration_policy: 'sanitized_only',
            raw_transcript_retention: providerTranscript
              ? buildRawTranscriptRetention(
                  sanitizedProviderTranscript,
                  options.rawTranscriptEncryptionKey ?? process.env.TRANSCRIPT_ENCRYPTION_KEY,
                )
              : null,
          },
        });

        // RIVET I13 — stamp provenance for the AUTHENTICATED in-app path.
        // This worker is the only place operator memos (source='inapp_voice',
        // created by the authenticated POST /voice/recordings routes) get
        // transcribed; the telephony path runs through transcript-ingestion-
        // worker, which stamps caller/mixed/operator from per-turn speakers.
        // Without this, an operator memo's row stays unstamped and
        // classifyRecordingProvenance (fail-closed) would treat the operator's
        // own recording as untrusted. Guarded on source + failure-soft.
        if (voiceRepository.stampProvenance) {
          try {
            const rec = await voiceRepository.findById(tenantId, recordingId);
            if (rec?.source === 'inapp_voice') {
              await voiceRepository.stampProvenance(tenantId, recordingId, 'operator');
            }
          } catch (err) {
            logger.warn('stampProvenance (transcription) failed', {
              recordingId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        logger.info('Transcription completed', {
          recordingId,
          correctionApplied: correctionMetadata.correctionApplied ?? false,
        });

        if (options.onTranscribed && sanitizedTranscript) {
          try {
            await options.onTranscribed(
              {
                tenantId,
                recordingId,
                transcript: sanitizedTranscript,
                conversationId,
                userId,
                ...(jobId ? { jobId } : {}),
              },
              logger
            );
          } catch (hookErr) {
            // Hook errors must not fail the transcription — the transcript is
            // already persisted. Log and swallow so the queue doesn't retry a
            // transcription that already succeeded.
            const error = hookErr instanceof Error ? hookErr : new Error(String(hookErr));
            logger.error('Transcription onTranscribed hook failed', {
              recordingId,
              error: error.message,
            });
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error('Transcription failed', { recordingId, error: error.message });

        await voiceRepository.updateStatus(tenantId, recordingId, 'failed', {
          error: error.message,
        });

        throw err;
      }
    },
  };
}
