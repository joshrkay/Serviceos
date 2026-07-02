#!/usr/bin/env node
/**
 * Deploy-time script: synthesizes each filler in FILLER_LIBRARY via the
 * ElevenLabs TTS API (requesting raw PCM 16 kHz directly) and writes the
 * PCM bytes to packages/api/src/ai/agents/customer-calling/fillers/<id>.pcm.
 *
 * Run manually before deploys when the library or voice changes:
 *
 *   ELEVENLABS_API_KEY=... npx tsx scripts/render-fillers.ts
 *
 * The script is intentionally idempotent — re-running with the same
 * voice + library produces byte-identical files (given the same model).
 *
 * Output format: raw PCM 16-bit signed little-endian @ 16 kHz mono — fed
 * directly to the media stream at runtime with no conversion needed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILLER_LIBRARY } from '../packages/api/src/ai/agents/customer-calling/fillers/manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';

async function main(): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is required. Set it before running this script.');
  }
  // Guard against malformed voice IDs that would silently produce 404s
  // (or worse, hit an unintended ElevenLabs path segment).
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(ELEVENLABS_VOICE_ID)) {
    throw new Error(
      `ELEVENLABS_VOICE_ID must be 10-64 alphanumerics / dashes / underscores; got: ${JSON.stringify(ELEVENLABS_VOICE_ID)}`,
    );
  }

  const outDir = resolve(
    __dirname,
    '../packages/api/src/ai/agents/customer-calling/fillers',
  );
  mkdirSync(outDir, { recursive: true });

  for (const filler of FILLER_LIBRARY) {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=pcm_16000`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/pcm',
        },
        body: JSON.stringify({
          text: filler.text,
          // UB-C2 — Spanish clips need the multilingual model; turbo v2.5
          // mangles Spanish prosody. Mirrors ElevenLabsTtsProvider's
          // language routing in packages/api/src/ai/tts/tts-provider.ts.
          model_id:
            filler.language === 'es' ? 'eleven_multilingual_v2' : 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    );

    if (!res.ok) {
      throw new Error(
        `render failed for ${filler.id}: HTTP ${res.status} ${res.statusText}`,
      );
    }

    const pcm = Buffer.from(await res.arrayBuffer());
    const outPath = resolve(outDir, `${filler.id}.pcm`);
    writeFileSync(outPath, pcm);
    // eslint-disable-next-line no-console
    console.log(`rendered ${filler.id} → ${outPath} (${pcm.length} bytes)`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
