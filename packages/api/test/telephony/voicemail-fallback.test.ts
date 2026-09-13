import { describe, expect, it } from 'vitest';
import { buildVoicemailTwiml } from '../../src/telephony/voicemail-fallback';

describe('buildVoicemailTwiml', () => {
  it('includes shop name, Record verb, and callback URL', () => {
    const xml = buildVoicemailTwiml({
      shopName: 'Ortega HVAC',
      recordingStatusCallback: 'https://api.example.com/api/telephony/voicemail-status',
    });
    expect(xml).toContain('Ortega HVAC');
    expect(xml).toContain('<Record');
    expect(xml).toContain('recordingStatusCallback="https://api.example.com/api/telephony/voicemail-status"');
    expect(xml).toContain('<Hangup/>');
  });

  it('escapes XML special characters in shop name', () => {
    const xml = buildVoicemailTwiml({
      shopName: 'Tom & Jerry <HVAC>',
      recordingStatusCallback: '/callback',
    });
    expect(xml).toContain('Tom &amp; Jerry &lt;HVAC&gt;');
    expect(xml).not.toContain('Tom & Jerry');
  });

  // U9 — Twilio's recordingStatusCallback POST carries no From/To, so the
  // caller/dialed numbers must ride the callback URL itself (signed by
  // Twilio, so tamper-proof on the way back).
  it('threads caller and dialed numbers onto the callback URL as query params', () => {
    const xml = buildVoicemailTwiml({
      shopName: 'Ortega HVAC',
      recordingStatusCallback: 'https://api.example.com/api/telephony/voicemail-status',
      callerPhone: '+15125550100',
      dialedNumber: '+15125550199',
    });
    // URL-encoded ('+' → %2B) then XML-escaped ('&' → &amp;).
    expect(xml).toContain(
      'recordingStatusCallback="https://api.example.com/api/telephony/voicemail-status' +
        '?From=%2B15125550100&amp;To=%2B15125550199"',
    );
  });

  it('appends with & when the callback URL already carries a query string', () => {
    const xml = buildVoicemailTwiml({
      shopName: 'Ortega HVAC',
      recordingStatusCallback: 'https://api.example.com/vm?x=1',
      callerPhone: '+15125550100',
    });
    expect(xml).toContain('recordingStatusCallback="https://api.example.com/vm?x=1&amp;From=%2B15125550100"');
  });

  it('leaves the callback URL untouched when no numbers are provided (legacy shape)', () => {
    const xml = buildVoicemailTwiml({
      shopName: 'Ortega HVAC',
      recordingStatusCallback: 'https://api.example.com/api/telephony/voicemail-status',
    });
    expect(xml).toContain(
      'recordingStatusCallback="https://api.example.com/api/telephony/voicemail-status"',
    );
    expect(xml).not.toContain('From=');
  });
});
