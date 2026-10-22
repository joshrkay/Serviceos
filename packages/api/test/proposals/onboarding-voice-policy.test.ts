/**
 * onboarding_voice_policy — the proposal "pick, don't build" onboarding mints
 * for the choices the five existing onboarding_* proposals do not cover:
 * greeting, book-or-hold, after-hours mode, emergency target, payment mode and
 * the booking-hours preset. One proposal, one approval, one settings write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onboardingVoicePolicyPayloadSchema, bookingHoursFromPreset } from '../../src/proposals/contracts/onboarding';
import { OnboardingVoicePolicyExecutionHandler } from '../../src/proposals/execution/onboarding-handlers';
import { PROPOSAL_TYPE_SCHEMAS } from '../../src/proposals/contracts';
import { VALID_PROPOSAL_TYPES, actionClassForProposalType } from '../../src/proposals/proposal';
import type { ExecutionContext } from '../../src/proposals/execution/handlers';
import type { Proposal } from '../../src/proposals/proposal';
import type { SettingsRepository } from '../../src/settings/settings';

const TENANT = '11111111-1111-1111-1111-111111111111';
const context: ExecutionContext = { tenantId: TENANT, executedBy: 'user_owner', executedByRole: 'owner' };

function proposalOf(payload: Record<string, unknown>): Proposal {
  return { id: 'prop_vp', tenantId: TENANT, proposalType: 'onboarding_voice_policy', status: 'approved', payload, summary: 'voice policy' } as Proposal;
}

describe('onboardingVoicePolicyPayloadSchema', () => {
  it('accepts a full payload', () => {
    const r = onboardingVoicePolicyPayloadSchema.safeParse({
      voiceGreeting: 'Walsh Plumbing, how can I help?',
      autonomousBookingEnabled: true,
      afterHoursVoiceMode: 'ai_answering',
      emergencyTarget: 'owner_cell',
      paymentCollectionMode: 'pay_link',
      bookingHoursPreset: 'mon_sat_7_5',
    });
    expect(r.success).toBe(true);
  });
  it('requires at least one field', () => {
    expect(onboardingVoicePolicyPayloadSchema.safeParse({}).success).toBe(false);
  });
  it('rejects bad enums and strips unknown keys (strip-mode, like every proposal schema)', () => {
    expect(onboardingVoicePolicyPayloadSchema.safeParse({ afterHoursVoiceMode: 'answer-and-book' }).success).toBe(false);
    const r = onboardingVoicePolicyPayloadSchema.safeParse({ voiceGreeting: 'x', quotePolicy: 'range' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ voiceGreeting: 'x' });
  });
  it('is registered as a proposal type with its schema and stays in the capture action class', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('onboarding_voice_policy');
    expect(PROPOSAL_TYPE_SCHEMAS.onboarding_voice_policy).toBe(onboardingVoicePolicyPayloadSchema);
    expect(actionClassForProposalType('onboarding_voice_policy')).toBe('capture');
  });
});

describe('bookingHoursFromPreset', () => {
  it('maps the three presets to business hours maps', () => {
    const monSat = bookingHoursFromPreset('mon_sat_7_5');
    expect(Object.keys(monSat)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect(monSat.sat).toEqual({ open: '07:00', close: '17:00' });
    expect(monSat.sun).toBeNull();
    const weekdays = bookingHoursFromPreset('weekdays_7_5');
    expect(weekdays.sat).toBeNull();
    expect(weekdays.mon).toEqual({ open: '07:00', close: '17:00' });
    const any = bookingHoursFromPreset('any_time');
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) expect(any[d]).toEqual({ open: '00:00', close: '23:59' });
  });
});

describe('OnboardingVoicePolicyExecutionHandler', () => {
  let settingsRepo: { update: ReturnType<typeof vi.fn>; findByTenant: ReturnType<typeof vi.fn> };
  let auditRepo: { create: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    settingsRepo = {
      update: vi.fn().mockResolvedValue({}),
      findByTenant: vi.fn().mockResolvedValue({ escalationSettings: { channel_sms: false } }),
    };
    auditRepo = { create: vi.fn().mockResolvedValue(undefined) };
  });

  function handler() {
    return new OnboardingVoicePolicyExecutionHandler(settingsRepo as unknown as SettingsRepository, auditRepo as never);
  }

  it('writes every chosen value through SettingsRepository.update in one call and audits it', async () => {
    const result = await handler().execute(
      proposalOf({
        voiceGreeting: 'Walsh Plumbing, how can I help?',
        autonomousBookingEnabled: true,
        afterHoursVoiceMode: 'voicemail',
        emergencyTarget: 'owner_cell_then_text',
        paymentCollectionMode: 'collect_on_site',
        bookingHoursPreset: 'weekdays_7_5',
      }),
      context,
    );
    expect(result).toEqual({ success: true, resultEntityId: TENANT });
    expect(settingsRepo.update).toHaveBeenCalledTimes(1);
    const [tenantId, updates] = settingsRepo.update.mock.calls[0];
    expect(tenantId).toBe(TENANT);
    expect(updates).toMatchObject({
      voiceGreeting: 'Walsh Plumbing, how can I help?',
      autonomousBookingEnabled: true,
      paymentCollectionMode: 'collect_on_site',
      escalationSettings: { channel_sms: false, after_hours_voice_mode: 'voicemail', emergency_target: 'owner_cell_then_text' },
    });
    expect(updates.businessHours.sat).toBeNull();
    expect(auditRepo.create).toHaveBeenCalledTimes(1);
    const audit = auditRepo.create.mock.calls[0][0];
    expect(audit.eventType).toBe('tenant.voice_policy_set');
    expect(audit.metadata.source).toBe('onboarding_readback');
  });

  it('merges escalation settings instead of replacing them', async () => {
    settingsRepo.findByTenant.mockResolvedValue({ escalationSettings: { trigger_llm_sentiment: true, after_hours_voice_mode: 'ai_answering' } });
    await handler().execute(proposalOf({ emergencyTarget: 'owner_cell' }), context);
    const updates = settingsRepo.update.mock.calls[0][1];
    expect(updates.escalationSettings).toEqual({ trigger_llm_sentiment: true, after_hours_voice_mode: 'ai_answering', emergency_target: 'owner_cell' });
    expect(updates).not.toHaveProperty('voiceGreeting');
    expect(updates).not.toHaveProperty('businessHours');
  });

  it('writes only what the payload carries', async () => {
    await handler().execute(proposalOf({ voiceGreeting: 'Hi' }), context);
    const updates = settingsRepo.update.mock.calls[0][1];
    expect(Object.keys(updates)).toEqual(['voiceGreeting']);
  });

  it('refuses a payload that fails the contract without writing', async () => {
    const result = await handler().execute(proposalOf({ afterHoursVoiceMode: 'nope' }), context);
    expect(result.success).toBe(false);
    expect(settingsRepo.update).not.toHaveBeenCalled();
    expect(auditRepo.create).not.toHaveBeenCalled();
  });

  it('fails closed when the settings repo is not wired', async () => {
    const h = new OnboardingVoicePolicyExecutionHandler(undefined, auditRepo as never);
    expect(h.isFullyWired()).toBe(false);
    const result = await h.execute(proposalOf({ voiceGreeting: 'Hi' }), context);
    expect(result).toEqual({ success: false, error: 'handler_not_wired:settingsRepo' });
  });

  it('reports the repository error rather than claiming success', async () => {
    settingsRepo.update.mockRejectedValue(new Error('db down'));
    const result = await handler().execute(proposalOf({ voiceGreeting: 'Hi' }), context);
    expect(result).toEqual({ success: false, error: 'db down' });
    expect(auditRepo.create).not.toHaveBeenCalled();
  });
});
