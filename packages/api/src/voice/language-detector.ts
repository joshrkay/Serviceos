/**
 * Phase 4c language detector — measurement-only telemetry surface.
 *
 * Used in three places:
 *   1. End-of-session in inapp-adapter / twilio-adapter — detect from
 *      the joined transcript and stamp `voice_recordings.detected_language`.
 *   2. Per-retrieval inside `retrieve-adapter` — detect from `queryText`
 *      and log on `retrieval_eval_runs.detected_language`.
 *   3. Pre-bias on inbound caller-ID match — when
 *      `customers.preferred_language` is set, the FSM passes it as a
 *      hint instead of running detection on the first turn.
 *
 * Why offline (`franc-min`) and not OpenAI / Twilio: detection runs on
 * every retrieval call (which means every FSM turn once Phase 4b is on),
 * so a 50ms network hop is unacceptable. Franc is microsecond-fast,
 * synchronous, ~30KB, no native deps. Accuracy on >50 chars is good
 * enough for the BCP-47 prefix we care about (en/es/vi/zh/tl); shorter
 * inputs return 'und' and the caller treats them as unknown.
 *
 * Output is BCP-47 short codes (`'en'`, `'es'`, `'vi'`, `'zh'`,
 * `'tl'`, …). The franc library returns ISO 639-3 (`'eng'`, `'spa'`,
 * `'vie'`, …); we map the small set we actively support and fall
 * through to the raw 3-letter code for everything else so unmapped
 * languages still show up in dashboards rather than silently
 * collapsing to 'und'.
 */

import { franc } from 'franc-min';

export interface LanguageDetection {
  /**
   * BCP-47 short code (`'en'`, `'es'`, `'vi'`, `'zh'`, `'tl'`) for the
   * languages we actively map. Falls through to the raw ISO 639-3 code
   * for unmapped languages so dashboards still see the long tail. `'und'`
   * means franc could not determine the language (typically input shorter
   * than `MIN_DETECTION_LENGTH` or all-symbols/numbers).
   */
  language: string;
  /** Heuristic in [0, 1]. Currently a length-based proxy; franc itself
   *  doesn't expose a calibrated score. Phase 4d may swap to a real
   *  classifier with calibrated probabilities. */
  confidence: number;
}

export interface LanguageDetector {
  detect(text: string): LanguageDetection;
}

/**
 * Minimum input size (UTF-8 bytes) below which we return `'und'` rather
 * than letting franc guess on too little signal — the smoke test
 * misclassified "Hello short" as Somali. Bytes (not codepoints) so that
 * CJK input gets parity with ASCII: a 10-character Mandarin utterance
 * is ~30 UTF-8 bytes, which is roughly the same information density as
 * a 30-character English sentence.
 */
export const MIN_DETECTION_BYTES = 30;

const ISO_639_3_TO_BCP_47: Record<string, string> = {
  eng: 'en',
  spa: 'es',
  vie: 'vi',
  cmn: 'zh', // Mandarin
  yue: 'zh', // Cantonese — collapses to zh for tenant-level reporting
  tgl: 'tl', // Tagalog
  fra: 'fr',
  por: 'pt',
  rus: 'ru',
  kor: 'ko',
  jpn: 'ja',
  ara: 'ar',
  hin: 'hi',
  deu: 'de',
  ita: 'it',
};

export class FrancLanguageDetector implements LanguageDetector {
  detect(text: string): LanguageDetection {
    const trimmed = text?.trim() ?? '';
    if (trimmed.length === 0) return { language: 'und', confidence: 0 };
    const byteLength = Buffer.byteLength(trimmed, 'utf8');
    if (byteLength < MIN_DETECTION_BYTES) {
      return { language: 'und', confidence: 0 };
    }
    const iso = franc(trimmed);
    if (iso === 'und') return { language: 'und', confidence: 0 };

    const bcp47 = ISO_639_3_TO_BCP_47[iso] ?? iso;
    // Confidence proxy: the longer the input (in bytes, so CJK gets
    // parity with ASCII), the more we trust franc. Saturates at 200
    // bytes. Real calibration is a Phase 4d concern; until then this is
    // a sortable signal in the eval-run table.
    const confidence = Math.min(1, byteLength / 200);
    return { language: bcp47, confidence };
  }
}
