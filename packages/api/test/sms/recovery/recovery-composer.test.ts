/**
 * P8-015 — production RecoveryMessageComposer (createRecoveryComposer).
 *
 * Pins: the PII opt-in (exactly {contextCue, businessName} reach the
 * composer), the aiEnabled gate (mock-gateway output must never reach a
 * customer), and the fallback-on-failure behavior (an LLM outage degrades
 * to the deterministic template — never a throw back into the handler).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createRecoveryComposer,
  recoveryFallbackTemplate,
} from '../../../src/sms/recovery/recovery-composer';
import type { LLMGateway } from '../../../src/ai/gateway/gateway';
import type { ComposeBrandVoiceDeps } from '../../../src/ai/brand-voice/composer';
import type { SettingsRepository } from '../../../src/settings/settings';
import { createLogger } from '../../../src/logging/logger';
import { RECOVERY_SMS_MAX_CHARS } from '../../../src/sms/recovery/dropped-call-handler';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const TENANT = 'tenant-1';

function makeComposerDeps(reply: string): ComposeBrandVoiceDeps & {
  gateway: { complete: ReturnType<typeof vi.fn> };
} {
  const gateway = {
    complete: vi.fn(async () => ({
      content: reply,
      model: 'test',
      provider: 'stub',
      tokenUsage: { input: 0, output: 0, total: 0 },
      latencyMs: 0,
    })),
  };
  const settingsRepo = {
    findByTenant: vi.fn(async () => ({})),
  } as unknown as SettingsRepository;
  return { gateway: gateway as unknown as LLMGateway, settingsRepo } as never;
}

describe('createRecoveryComposer', () => {
  it('routes through the brand-voice composer when aiEnabled and returns its text', async () => {
    const deps = makeComposerDeps('Hey! We got disconnected — text back and we will finish up.');
    const compose = createRecoveryComposer({
      composerDeps: deps,
      businessName: 'Rivet HVAC',
      aiEnabled: true,
      logger,
    });

    const body = await compose({
      tenantId: TENANT,
      contextCue: 'We saved your AC repair request.',
      maxChars: RECOVERY_SMS_MAX_CHARS,
    });

    expect(body).toBe('Hey! We got disconnected — text back and we will finish up.');
    expect(deps.gateway.complete).toHaveBeenCalledTimes(1);
    // PII opt-in: the prompt must contain the curated cue, and the request
    // carries the recovery intent's task type only.
    const request = deps.gateway.complete.mock.calls[0][0];
    const promptText = JSON.stringify(request.messages);
    expect(promptText).toContain('We saved your AC repair request.');
    expect(promptText).toContain('Rivet HVAC');
  });

  it('aiEnabled=false uses the deterministic template and never calls the gateway', async () => {
    const deps = makeComposerDeps('mock output that must never reach a customer');
    const compose = createRecoveryComposer({
      composerDeps: deps,
      businessName: 'Rivet HVAC',
      aiEnabled: false,
      logger,
    });

    const body = await compose({
      tenantId: TENANT,
      contextCue: 'We saved your AC repair request.',
      maxChars: RECOVERY_SMS_MAX_CHARS,
    });

    expect(deps.gateway.complete).not.toHaveBeenCalled();
    expect(body).toBe(
      "Hi — this is Rivet HVAC. We got cut off on your call. We saved your AC repair request. Reply and we'll pick up where we left off.",
    );
  });

  it('falls back to the template (no throw) when the composer fails', async () => {
    const deps = makeComposerDeps('unused');
    (deps.gateway.complete as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('provider down'),
    );
    const compose = createRecoveryComposer({
      composerDeps: deps,
      businessName: 'Rivet HVAC',
      aiEnabled: true,
      logger,
    });

    const body = await compose({
      tenantId: TENANT,
      contextCue: '',
      maxChars: RECOVERY_SMS_MAX_CHARS,
    });

    expect(body).toBe(
      "Hi — this is Rivet HVAC. We got cut off on your call. Reply and we'll pick up where we left off.",
    );
  });
});

describe('recoveryFallbackTemplate', () => {
  it('reads correctly with an empty cue', () => {
    expect(
      recoveryFallbackTemplate({ businessName: 'Shop', contextCue: '', maxChars: 320 }),
    ).toBe("Hi — this is Shop. We got cut off on your call. Reply and we'll pick up where we left off.");
  });

  it('respects maxChars without cutting mid-word', () => {
    const text = recoveryFallbackTemplate({
      businessName: 'A Very Long Business Name LLC',
      contextCue: 'word '.repeat(100).trim(),
      maxChars: 120,
    });
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith(' ')).toBe(false);
    // No mid-word cut: the last token is a complete word from the input.
    const lastToken = text.split(' ').pop();
    expect(['word', 'call.', 'LLC.']).toContain(lastToken);
  });
});
