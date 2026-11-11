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
import { createLogger, type Logger } from '../../../src/logging/logger';
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
      fallbackBusinessName: 'Rivet HVAC',
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
      fallbackBusinessName: 'Rivet HVAC',
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
      fallbackBusinessName: 'Rivet HVAC',
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

/**
 * Per-tenant business name. The composer used to capture ONE name at boot
 * (`process.env.TWILIO_BUSINESS_NAME ?? 'our team'`), so every tenant's dropped
 * caller was told the platform's name. The name must be resolved per send from
 * the tenant's own settings, with the platform env value and then 'our team'
 * as fallbacks only when the tenant has none — on BOTH the deterministic
 * template path and the AI (brand-voice) path.
 */
describe('createRecoveryComposer — per-tenant business name', () => {
  const ENV_NAME = 'Platform Env Co';
  type Path = 'template' | 'ai';
  const PATHS: Path[] = ['template', 'ai'];

  type SettingsStub = { businessName?: string } | null;

  function makeSpyLogger() {
    const spy = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    spy.child.mockReturnValue(spy);
    return spy as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
  }

  /**
   * One composer over a per-tenant settings map. `nameFor(tenantId)` composes a
   * recovery SMS and returns the business name that path put in front of the
   * customer: parsed from the SMS body (template) or from the `businessName`
   * context line of the gateway prompt (AI) — never a loose substring match,
   * so the generic prompt copy cannot satisfy or break an assertion.
   */
  function setup(
    path: Path,
    settingsByTenant: Record<string, SettingsStub>,
    opts: { fallbackBusinessName?: string; logger?: Logger } = {},
  ) {
    const gateway = {
      complete: vi.fn(async (_request: { messages: Array<{ content: string }> }) => ({
        content: 'AI composed body',
        model: 'test',
        provider: 'stub',
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: 0,
      })),
    };
    const findByTenant = vi.fn(async (tenantId: string) => settingsByTenant[tenantId] ?? null);
    const composerDeps = {
      gateway: gateway as unknown as LLMGateway,
      settingsRepo: { findByTenant } as unknown as SettingsRepository,
    } as unknown as ComposeBrandVoiceDeps;
    const compose = createRecoveryComposer({
      composerDeps,
      ...(opts.fallbackBusinessName !== undefined
        ? { fallbackBusinessName: opts.fallbackBusinessName }
        : {}),
      aiEnabled: path === 'ai',
      logger: opts.logger ?? logger,
    });

    const nameFor = async (tenantId: string): Promise<string | undefined> => {
      const callsBefore = gateway.complete.mock.calls.length;
      const body = await compose({
        tenantId,
        contextCue: 'We saved your request.',
        maxChars: RECOVERY_SMS_MAX_CHARS,
      });
      if (path === 'template') {
        return /this is (.+?)\. We got cut off/.exec(body)?.[1];
      }
      const request = gateway.complete.mock.calls[callsBefore]?.[0];
      const prompt = (request?.messages ?? []).map((m) => m.content).join('\n');
      return /^- businessName: (.*)$/m.exec(prompt)?.[1];
    };

    return { compose, nameFor, gateway, findByTenant };
  }

  describe.each(PATHS)('%s path', (path) => {
    it("uses the tenant's own business name, not the platform fallback", async () => {
      const { nameFor } = setup(
        path,
        { 'tenant-a': { businessName: 'Acme Plumbing' } },
        { fallbackBusinessName: ENV_NAME },
      );

      expect(await nameFor('tenant-a')).toBe('Acme Plumbing');
    });

    it('trims surrounding whitespace from the tenant name', async () => {
      const { nameFor } = setup(
        path,
        { 'tenant-a': { businessName: '  Acme Plumbing  ' } },
        { fallbackBusinessName: ENV_NAME },
      );

      expect(await nameFor('tenant-a')).toBe('Acme Plumbing');
    });

    it.each([
      ['no settings row', null],
      ['an empty business name', { businessName: '' }],
      ['a whitespace-only business name', { businessName: '   ' }],
    ] as Array<[string, SettingsStub]>)(
      'falls back to the platform name (TWILIO_BUSINESS_NAME) when the tenant has %s',
      async (_label, settings) => {
        const { nameFor } = setup(
          path,
          { 'tenant-a': settings },
          { fallbackBusinessName: ENV_NAME },
        );

        expect(await nameFor('tenant-a')).toBe(ENV_NAME);
      },
    );

    it("falls back to 'our team' when the tenant has no name and no platform name is set", async () => {
      const { nameFor } = setup(path, { 'tenant-a': { businessName: '' } });

      expect(await nameFor('tenant-a')).toBe('our team');
    });

    it("treats an empty platform name as unset and falls back to 'our team'", async () => {
      const { nameFor } = setup(
        path,
        { 'tenant-a': null },
        { fallbackBusinessName: '' },
      );

      expect(await nameFor('tenant-a')).toBe('our team');
    });

    it('gives two tenants in the same process their own names (no boot-time capture)', async () => {
      const { nameFor } = setup(
        path,
        {
          'tenant-a': { businessName: 'Acme Plumbing' },
          'tenant-b': { businessName: 'Bright HVAC' },
          'tenant-c': { businessName: '' },
        },
        { fallbackBusinessName: ENV_NAME },
      );

      expect(await nameFor('tenant-a')).toBe('Acme Plumbing');
      expect(await nameFor('tenant-b')).toBe('Bright HVAC');
      expect(await nameFor('tenant-c')).toBe(ENV_NAME);
      // Resolved per send: tenant A again after B must not inherit B's name.
      expect(await nameFor('tenant-a')).toBe('Acme Plumbing');
    });

    it('picks up a renamed tenant on the next send (not cached for the process lifetime)', async () => {
      const settings: Record<string, SettingsStub> = {
        'tenant-a': { businessName: 'Old Name Plumbing' },
      };
      const { nameFor } = setup(path, settings, { fallbackBusinessName: ENV_NAME });

      expect(await nameFor('tenant-a')).toBe('Old Name Plumbing');
      settings['tenant-a'] = { businessName: 'New Name Plumbing' };
      expect(await nameFor('tenant-a')).toBe('New Name Plumbing');
    });
  });

  describe('a failed name lookup never blocks the send', () => {
    it('template path: falls back to the platform name and logs a warning', async () => {
      const logSpy = makeSpyLogger();
      const { compose, findByTenant } = setup(
        'template',
        {},
        { fallbackBusinessName: ENV_NAME, logger: logSpy },
      );
      findByTenant.mockRejectedValue(new Error('settings db down'));

      const body = await compose({
        tenantId: 'tenant-a',
        contextCue: '',
        maxChars: RECOVERY_SMS_MAX_CHARS,
      });

      expect(body).toBe(
        `Hi — this is ${ENV_NAME}. We got cut off on your call. Reply and we'll pick up where we left off.`,
      );
      expect(logSpy.warn).toHaveBeenCalledTimes(1);
      expect(logSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining('business name'),
        expect.objectContaining({ tenantId: 'tenant-a', error: 'settings db down' }),
      );
    });

    it("template path: falls back to 'our team' when the lookup fails and no platform name is set", async () => {
      const { compose, findByTenant } = setup('template', {}, { logger: makeSpyLogger() });
      findByTenant.mockRejectedValue(new Error('settings db down'));

      const body = await compose({
        tenantId: 'tenant-a',
        contextCue: '',
        maxChars: RECOVERY_SMS_MAX_CHARS,
      });

      expect(body).toContain('this is our team.');
    });

    it('AI path: a transient lookup failure still composes with the AI, using the platform name', async () => {
      const logSpy = makeSpyLogger();
      const { nameFor, gateway, findByTenant } = setup(
        'ai',
        { 'tenant-a': { businessName: 'Acme Plumbing' } },
        { fallbackBusinessName: ENV_NAME, logger: logSpy },
      );
      // Only the composer's own name lookup fails; the brand-voice composer's
      // settings read (tone) succeeds.
      findByTenant.mockRejectedValueOnce(new Error('settings blip'));

      expect(await nameFor('tenant-a')).toBe(ENV_NAME);
      expect(gateway.complete).toHaveBeenCalledTimes(1);
      expect(logSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining('business name'),
        expect.objectContaining({ tenantId: 'tenant-a', error: 'settings blip' }),
      );
    });

    it('AI path: a hard settings outage degrades to the template with the platform name (no throw)', async () => {
      const logSpy = makeSpyLogger();
      const { compose, gateway, findByTenant } = setup(
        'ai',
        {},
        { fallbackBusinessName: ENV_NAME, logger: logSpy },
      );
      findByTenant.mockRejectedValue(new Error('settings db down'));

      const body = await compose({
        tenantId: 'tenant-a',
        contextCue: '',
        maxChars: RECOVERY_SMS_MAX_CHARS,
      });

      expect(gateway.complete).not.toHaveBeenCalled();
      expect(body).toBe(
        `Hi — this is ${ENV_NAME}. We got cut off on your call. Reply and we'll pick up where we left off.`,
      );
      expect(logSpy.warn).toHaveBeenCalled();
    });
  });
});

describe('recoveryFallbackTemplate', () => {
  it('reads correctly with an empty cue', () => {
    expect(
      recoveryFallbackTemplate({ businessName: 'Shop', contextCue: '', maxChars: 320 }),
    ).toBe("Hi — this is Shop. We got cut off on your call. Reply and we'll pick up where we left off.");
  });

  it('respects maxChars without cutting mid-word (delegates to trimToMaxChars)', () => {
    const text = recoveryFallbackTemplate({
      businessName: 'A Very Long Business Name LLC',
      contextCue: 'word '.repeat(100).trim(),
      maxChars: 120,
    });
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith(' ')).toBe(false);
    // No mid-word cut: every whitespace-delimited token is a complete word
    // from the input (trimToMaxChars may append a "..." marker).
    for (const token of text.replace(/\.\.\.$/, '').trim().split(' ')) {
      expect(['Hi', '—', 'this', 'is', 'A', 'Very', 'Long', 'Business', 'Name', 'LLC.', 'We', 'got', 'cut', 'off', 'on', 'your', 'call.', 'word']).toContain(token);
    }
  });

  it('never exceeds maxChars even when the cap is tighter than the first word', () => {
    const text = recoveryFallbackTemplate({
      businessName: 'Supercalifragilisticexpialidocious Services',
      contextCue: '',
      maxChars: 8,
    });
    expect(text.length).toBeLessThanOrEqual(8);
  });
});
