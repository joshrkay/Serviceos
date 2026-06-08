/**
 * Feature 1 — Always-on answering with sub-2s pickup.
 *
 * Measures the server-controllable portion of pickup latency: per-call persona
 * resolution (cache hit) + recording-disclosure assembly + greeting build, the
 * work between the inbound webhook and the first TTS utterance. Network transit
 * and ElevenLabs/Twilio TTS synthesis are out of process and benchmarked
 * separately in staging (see COMPETITIVE.md); this gate protects against
 * regressions in the code path we own.
 *
 * Competitive bar: pickup p95 < 2000ms.
 */
import { describe, it, expect } from 'vitest';
import { buildTelephonyGreeting } from '../../src/telephony/twilio-adapter';
import type { VoicePersona } from '../../src/settings/voice-persona-resolver';
import type { Language } from '../../src/ai/i18n/i18n';
import { summarize } from '../../src/voice/parity/latency';

const PICKUP_P95_BUDGET_MS = 2000;
const SAMPLE_SIZE = 200;

/** Simulated 60s-cache persona store — a hit is a Map read, like production. */
function personaCache(): Map<string, VoicePersona> {
  return new Map([['tenant-1', { agentName: 'Alex' }]]);
}

function assembleGreeting(
  cache: Map<string, VoicePersona>,
  tenantId: string,
  businessName: string,
  language: Language,
): string {
  const persona = cache.get(tenantId) ?? null;
  // Disclosure is a constant-cost string concat in the real path.
  const disclosure = 'This call may be recorded for quality.';
  return buildTelephonyGreeting(businessName, disclosure, persona, language);
}

describe('Feature 1 — always-on sub-2s pickup', () => {
  it('greeting is personalized with business_name and agent_name (EN)', () => {
    const greeting = assembleGreeting(personaCache(), 'tenant-1', 'Acme Plumbing', 'en');
    expect(greeting).toContain('Acme Plumbing');
    expect(greeting).toContain('Alex');
    expect(greeting).toContain('How can I help you today?');
  });

  it('greeting is personalized and fully Spanish (ES)', () => {
    const greeting = assembleGreeting(personaCache(), 'tenant-1', 'Acme Plomería', 'es');
    expect(greeting).toContain('Acme Plomería');
    expect(greeting).toContain('Alex');
    expect(greeting).toContain('Gracias por llamar');
    // No English bleed into a Spanish greeting.
    expect(greeting).not.toContain('Thank you for calling');
    expect(greeting).not.toContain('How can I help');
  });

  it('falls back to a default opener when no persona is configured', () => {
    const greeting = assembleGreeting(new Map(), 'unknown', 'Acme Plumbing', 'en');
    expect(greeting).toContain('Acme Plumbing');
    expect(greeting).toContain('How can I help you today?');
  });

  it(`pickup p95 is under ${PICKUP_P95_BUDGET_MS}ms over ${SAMPLE_SIZE} synthetic calls`, () => {
    const cache = personaCache();
    const samples: number[] = [];
    const perf = globalThis.performance;
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const lang: Language = i % 2 === 0 ? 'en' : 'es';
      const start = perf ? perf.now() : Date.now();
      const greeting = assembleGreeting(cache, 'tenant-1', 'Acme Plumbing', lang);
      const elapsed = (perf ? perf.now() : Date.now()) - start;
      // Guard against the optimizer eliding the call.
      expect(greeting.length).toBeGreaterThan(0);
      samples.push(elapsed);
    }
    const stats = summarize(samples);
    expect(stats.count).toBe(SAMPLE_SIZE);
    expect(stats.p95).toBeLessThan(PICKUP_P95_BUDGET_MS);
    expect(stats.p99).toBeLessThan(PICKUP_P95_BUDGET_MS);
  });
});
