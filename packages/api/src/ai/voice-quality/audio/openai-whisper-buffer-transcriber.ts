/**
 * #1331 — the Layer 2 harness's buffer-in Whisper transcriber: posts the
 * agent audio the emulator collected (PCM16 LE, mono, 8 kHz — see
 * `decodeAgentOutbound`) to OpenAI's audio transcriptions endpoint, the same
 * multipart wire format the production `WhisperTranscriptionProvider` uses.
 *
 * Lives in src (not the Layer 2 entry test) so its wire format is tested.
 */
import type { WhisperBufferTranscriber } from './whisper-real-provider';

export interface OpenAiWhisperBufferTranscriberDeps {
  apiKey: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** The emulator's agent-audio format (telephony PCM after μ-law decode). */
const SAMPLE_RATE = 8000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

/**
 * Wrap raw PCM16 LE mono 8 kHz in a canonical 44-byte RIFF/WAVE header.
 * Whisper sniffs the container; headerless PCM is undecodable, and weekly run
 * 36829085635 lost every agent transcript to exactly that.
 */
function pcm16ToWav(pcm: Buffer): Buffer {
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createOpenAiWhisperBufferTranscriber(
  deps: OpenAiWhisperBufferTranscriberDeps,
): WhisperBufferTranscriber {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    async transcribeBuffer(audio: Buffer) {
      const fd = new FormData();
      fd.append('file', new Blob([pcm16ToWav(audio)], { type: 'audio/wav' }), 'audio.wav');
      fd.append('model', 'whisper-1');
      const res = await doFetch(TRANSCRIPTIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        body: fd,
        // fetch has no default timeout; a stalled Whisper call would hold the
        // script past its per-test budget.
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Structured status so WhisperRealProvider's 429 retry detection works.
        const err = new Error(`whisper transcribe failed: ${res.status} ${body.slice(0, 200)}`);
        (err as { status?: number }).status = res.status;
        throw err;
      }
      const data = (await res.json()) as { text?: string };
      return {
        transcript: data.text ?? '',
        metadata: { provider: 'openai-whisper-buffer', model: 'whisper-1' },
      };
    },
  };
}
