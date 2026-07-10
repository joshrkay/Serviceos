import { describe, it, expect } from 'vitest';
import { AppError } from '../../../src/shared/errors';
import { InMemoryBrandVoiceRepository } from '../../../src/tenants/brand/in-memory-brand-voice-repository';
import { BRAND_VOICE_COOLDOWN_MS } from '../../../src/tenants/brand/brand-voice';
import {
  updateBrandVoice,
  rollbackBrandVoice,
} from '../../../src/tenants/brand/brand-voice-service';

const actor = { tenantId: 't1', userId: 'u1', role: 'owner' };

const sixFields = {
  register: 'friendly' as const,
  opening_lines: ['Hi there'],
  signoff: '— The team',
  banned_phrases: ['no refunds'],
  persona_name: "M&R Mechanical's office",
  pronoun: 'we' as const,
};

describe('N-011 — brand-voice service', () => {
  it('onboarding captures all six fields and writes version 1 + an audit event', async () => {
    const repo = new InMemoryBrandVoiceRepository();
    const result = await updateBrandVoice(
      { actor, patch: sixFields, onboarding: true },
      repo,
    );

    expect(result.state.version).toBe(1);
    expect(result.state.locked).toBe(true);
    expect(result.state.config).toMatchObject(sixFields);

    const versions = await repo.listVersions('t1');
    expect(versions).toHaveLength(1);
    expect(versions[0].changeReason).toBe('onboarding');
    expect(versions[0].snapshot).toMatchObject(sixFields);

    expect(result.audit.eventType).toBe('brand_voice.updated');
    expect(result.audit.entityType).toBe('brand_voice');
    expect(result.audit.metadata).toMatchObject({ fromVersion: 0, toVersion: 1 });
  });

  it('enforces the 15-minute cool-down (423) on a web edit, and allows it after the window', async () => {
    const repo = new InMemoryBrandVoiceRepository();
    const t0 = Date.parse('2026-07-10T12:00:00.000Z');
    // Onboarding (exempt) sets the anchor.
    await updateBrandVoice({ actor, patch: sixFields, onboarding: true, now: t0 }, repo);

    // A web edit 5 minutes later is inside the cool-down → 423.
    await expect(
      updateBrandVoice(
        { actor, patch: { register: 'formal' }, now: t0 + 5 * 60_000 },
        repo,
      ),
    ).rejects.toMatchObject({ code: 'BRAND_VOICE_COOLDOWN', statusCode: 423 });

    // After the window it succeeds and bumps to v2.
    const after = await updateBrandVoice(
      { actor, patch: { register: 'formal' }, now: t0 + BRAND_VOICE_COOLDOWN_MS },
      repo,
    );
    expect(after.state.version).toBe(2);
    expect(after.state.config.register).toBe('formal');
    // Banned phrases from onboarding survive the edit (union merge).
    expect(after.state.config.banned_phrases).toEqual(['no refunds']);
  });

  it('does NOT let a client-supplied onboarding:true bypass the cool-down after the first write', async () => {
    const repo = new InMemoryBrandVoiceRepository();
    const t0 = Date.parse('2026-07-10T12:00:00.000Z');
    // Genuine initial onboarding write (version 0 -> 1), exempt from cool-down.
    await updateBrandVoice({ actor, patch: sixFields, onboarding: true, now: t0 }, repo);

    // A second call 5 minutes later spoofing onboarding:true must STILL 423 —
    // the exemption is gated on the initial unconfigured state, not the flag.
    await expect(
      updateBrandVoice(
        { actor, patch: { register: 'formal' }, onboarding: true, now: t0 + 5 * 60_000 },
        repo,
      ),
    ).rejects.toMatchObject({ code: 'BRAND_VOICE_COOLDOWN', statusCode: 423 });

    // After the window, an onboarding-spoofed edit succeeds but is recorded as
    // a web_edit (not mislabeled 'onboarding').
    const after = await updateBrandVoice(
      { actor, patch: { register: 'formal' }, onboarding: true, now: t0 + BRAND_VOICE_COOLDOWN_MS },
      repo,
    );
    expect(after.state.version).toBe(2);
    const versions = await repo.listVersions('t1');
    expect(versions.find((v) => v.version === 2)?.changeReason).toBe('web_edit');
  });

  it('rollback re-persists an older snapshot as a NEW bump and audits change_reason=rollback', async () => {
    const repo = new InMemoryBrandVoiceRepository();
    const t0 = Date.parse('2026-07-10T12:00:00.000Z');
    await updateBrandVoice({ actor, patch: { register: 'friendly' }, onboarding: true, now: t0 }, repo);
    await updateBrandVoice(
      { actor, patch: { register: 'formal' }, now: t0 + BRAND_VOICE_COOLDOWN_MS },
      repo,
    );

    // Roll back to v1 (register: friendly) after another cool-down window.
    const rolled = await rollbackBrandVoice(
      { actor, version: 1, now: t0 + 2 * BRAND_VOICE_COOLDOWN_MS },
      repo,
    );
    expect(rolled.state.version).toBe(3);
    expect(rolled.state.config.register).toBe('friendly');
    expect(rolled.audit.metadata).toMatchObject({ changeReason: 'rollback', rolledBackTo: 1 });
  });

  it('rollback to a missing version throws 404', async () => {
    const repo = new InMemoryBrandVoiceRepository();
    await expect(
      rollbackBrandVoice({ actor, version: 9 }, repo),
    ).rejects.toBeInstanceOf(AppError);
  });
});
