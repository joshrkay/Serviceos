/**
 * #1331 — the Layer 2 Whisper leg uploads the agent's audio as a real WAV.
 *
 * Weekly run 36829085635 graded every agent turn as "<response not
 * captured>": the harness posted headerless PCM16 bytes named `audio.wav`,
 * which Whisper cannot decode, the driver swallowed the 400, and no Whisper
 * cent was ever booked. The upload must be a RIFF/WAVE container describing
 * the emulator's telephony PCM (16-bit, mono, 8 kHz).
 */
import { describe, expect, it } from 'vitest';

import { createOpenAiWhisperBufferTranscriber } from '../../../src/ai/voice-quality/audio/openai-whisper-buffer-transcriber';

async function captureUpload(pcm: Buffer): Promise<{ file: Buffer; url: string; model: unknown; auth: string | null }> {
  let captured: { file: Buffer; url: string; model: unknown; auth: string | null } | undefined;
  const transcriber = createOpenAiWhisperBufferTranscriber({
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      const form = init?.body as FormData;
      const blob = form.get('file') as Blob;
      captured = {
        file: Buffer.from(await blob.arrayBuffer()),
        url: String(url),
        model: form.get('model'),
        auth: new Headers(init?.headers).get('authorization'),
      };
      return new Response(JSON.stringify({ text: 'Your catalog is empty right now.' }), { status: 200 });
    },
  });
  const result = await transcriber.transcribeBuffer(pcm);
  expect(result.transcript).toBe('Your catalog is empty right now.');
  return captured!;
}

describe('createOpenAiWhisperBufferTranscriber (#1331)', () => {
  it('uploads the PCM16 mono 8 kHz agent audio inside a RIFF/WAVE container', async () => {
    const pcm = Buffer.alloc(1600, 1); // 50 ms of 8 kHz 16-bit mono
    const { file, url, model, auth } = await captureUpload(pcm);

    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(model).toBe('whisper-1');
    expect(auth).toBe('Bearer sk-test');

    // Canonical 44-byte PCM WAV header (RIFF spec).
    expect(file.length).toBe(44 + 1600);
    expect(file.toString('ascii', 0, 4)).toBe('RIFF');
    expect(file.readUInt32LE(4)).toBe(36 + 1600);
    expect(file.toString('ascii', 8, 12)).toBe('WAVE');
    expect(file.toString('ascii', 12, 16)).toBe('fmt ');
    expect(file.readUInt32LE(16)).toBe(16); // fmt chunk size
    expect(file.readUInt16LE(20)).toBe(1); // PCM
    expect(file.readUInt16LE(22)).toBe(1); // mono
    expect(file.readUInt32LE(24)).toBe(8000); // sample rate
    expect(file.readUInt32LE(28)).toBe(16000); // byte rate
    expect(file.readUInt16LE(32)).toBe(2); // block align
    expect(file.readUInt16LE(34)).toBe(16); // bits per sample
    expect(file.toString('ascii', 36, 40)).toBe('data');
    expect(file.readUInt32LE(40)).toBe(1600);
    expect(file.subarray(44).equals(pcm)).toBe(true);
  });

  it('surfaces a non-OK response with its status so 429s can be retried', async () => {
    const transcriber = createOpenAiWhisperBufferTranscriber({
      apiKey: 'sk-test',
      fetchImpl: async () => new Response('slow down', { status: 429 }),
    });
    await expect(transcriber.transcribeBuffer(Buffer.alloc(320))).rejects.toMatchObject({ status: 429 });
  });
});
