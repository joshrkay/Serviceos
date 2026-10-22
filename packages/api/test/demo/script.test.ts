/**
 * S6-3 (U7 "Consent line first") — the consent line the demo always speaks
 * before the turn processor's greeting (owner decision 2's default copy),
 * and the TwiML that puts it first. S6-6 wires it into the voice route.
 */
import { describe, it, expect } from 'vitest';
import { demoConsentLine, withDemoConsent, DEMO_BUSY_MESSAGE } from '../../src/demo/script';

describe('demo consent line', () => {
  it('is the recommended copy with the business name', () => {
    expect(demoConsentLine('Austin Pipe Pros')).toBe(
      "This is a demo from Rivet. This call may be recorded. You're the customer; I'm answering for Austin Pipe Pros.",
    );
  });

  it('is spoken before the greeting the turn processor rendered, inside the same Response', () => {
    const turn =
      '<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="/next"><Say voice="Polly.Joanna">Thanks for calling.</Say></Gather></Response>';
    expect(withDemoConsent('Austin Pipe Pros', turn)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This is a demo from Rivet. This call may be recorded. You&apos;re the customer; I&apos;m answering for Austin Pipe Pros.</Say><Gather input="speech" action="/next"><Say voice="Polly.Joanna">Thanks for calling.</Say></Gather></Response>',
    );
  });

  it('speaks with the given voice and escapes the visitor-typed business name', () => {
    const out = withDemoConsent('Pipes & <Sons>', '<Response><Hangup/></Response>', { voice: 'Polly.Matthew' });
    expect(out).toBe(
      '<Response><Say voice="Polly.Matthew">This is a demo from Rivet. This call may be recorded. You&apos;re the customer; I&apos;m answering for Pipes &amp; &lt;Sons&gt;.</Say><Hangup/></Response>',
    );
  });

  it('a turn without a Response element gets one, with the consent line first', () => {
    expect(withDemoConsent('A1', '')).toBe(
      '<Response><Say>This is a demo from Rivet. This call may be recorded. You&apos;re the customer; I&apos;m answering for A1.</Say></Response>',
    );
  });

  it('the busy copy is plain words', () => {
    expect(DEMO_BUSY_MESSAGE).toBe('Every line is busy. Try again in a minute.');
  });
});
