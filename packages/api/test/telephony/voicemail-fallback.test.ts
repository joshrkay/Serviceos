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
});
