import { describe, it, expect } from 'vitest';
import {
  evaluateHandoffContextArtifacts,
  HANDOFF_VERIFY_MARKERS,
} from '../../scripts/handoff-context-verdict';
import {
  HANDOFF_VERIFY_FIXTURE,
  runHandoffContextVerify,
} from '../../scripts/handoff-context-verify';

const TRANSFER = HANDOFF_VERIFY_FIXTURE.transferNumber;

function passingArtifacts() {
  return {
    smsBody:
      'Acme Plumbing: Incoming call from María López (512-555-0142). Re: scheduling a visit. Gold Plan member. Reason: operator request. Next: book the visit. api.test/c/esc_abc',
    whisperText:
      'Incoming call from María López. Scheduling a visit. Gold Plan member. Reason: operator request. Suggested: book the visit.',
    panelLastInteraction: 'Last service: Jan 10 — AC tune-up · Notes: Prefers mornings.',
    panelTags: ['vip', 'Spanish'],
    dialTwiml: `<Response><Dial><Number>${TRANSFER}</Number></Dial></Response>`,
    transferNumber: TRANSFER,
  };
}

describe('evaluateHandoffContextArtifacts', () => {
  it('passes when all CRM markers are present', () => {
    const v = evaluateHandoffContextArtifacts(passingArtifacts());
    expect(v.ok).toBe(true);
    expect(v.checks.every((c) => c.ok)).toBe(true);
  });

  it('fails when SMS lacks membership (the verify gap this closes)', () => {
    const v = evaluateHandoffContextArtifacts({
      ...passingArtifacts(),
      smsBody: 'Acme Plumbing: Incoming call from María. Reason: operator request.',
    });
    expect(v.ok).toBe(false);
    const membership = v.checks.find((c) => c.name === 'sms-membership');
    expect(membership?.ok).toBe(false);
    expect(membership?.detail).toMatch(/CRM hydration failed/);
  });

  it('fails when whisper lacks membership', () => {
    const v = evaluateHandoffContextArtifacts({
      ...passingArtifacts(),
      whisperText: 'Incoming call from María. Reason: operator request.',
    });
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === 'whisper-membership')?.ok).toBe(false);
  });

  it('fails when panel is missing last service or notes', () => {
    const noService = evaluateHandoffContextArtifacts({
      ...passingArtifacts(),
      panelLastInteraction: 'Notes: Prefers mornings.',
    });
    expect(noService.checks.find((c) => c.name === 'panel-last-service')?.ok).toBe(false);

    const noNotes = evaluateHandoffContextArtifacts({
      ...passingArtifacts(),
      panelLastInteraction: 'Last service: Jan 10 — AC tune-up',
    });
    expect(noNotes.checks.find((c) => c.name === 'panel-notes')?.ok).toBe(false);
  });

  it('fails when vip tag is missing from panel', () => {
    const v = evaluateHandoffContextArtifacts({
      ...passingArtifacts(),
      panelTags: ['Spanish'],
    });
    expect(v.checks.find((c) => c.name === 'panel-tags')?.ok).toBe(false);
  });

  it('fails when Dial TwiML does not target the transfer number', () => {
    const v = evaluateHandoffContextArtifacts({
      ...passingArtifacts(),
      dialTwiml: '<Response><Dial><Number>+15550001111</Number></Dial></Response>',
    });
    expect(v.checks.find((c) => c.name === 'dial-queued')?.ok).toBe(false);
  });
});

describe('runHandoffContextVerify', () => {
  it('passes end-to-end with seeded CRM fixture', async () => {
    const report = await runHandoffContextVerify();
    expect(report.ok).toBe(true);
    expect(report.artifacts.smsBody).toMatch(HANDOFF_VERIFY_MARKERS.membership);
    expect(report.artifacts.whisperText).toMatch(HANDOFF_VERIFY_MARKERS.membership);
    expect(report.artifacts.panelLastInteraction).toMatch(HANDOFF_VERIFY_MARKERS.lastService);
    expect(report.artifacts.panelLastInteraction).toMatch(HANDOFF_VERIFY_MARKERS.notes);
    expect(report.artifacts.panelTags).toContain(HANDOFF_VERIFY_MARKERS.tag);
    expect(report.artifacts.dialTwiml).toContain(TRANSFER);
    expect(report.artifacts.smsTo).toBe(TRANSFER);
  });

  it('fails when CRM is not seeded (proves checks are not vacuously true)', async () => {
    const report = await runHandoffContextVerify({ skipSeed: true });
    expect(report.ok).toBe(false);
    const failed = report.verdict.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        'sms-membership',
        'whisper-membership',
        'panel-last-service',
        'panel-notes',
        'panel-tags',
      ]),
    );
  });
});
