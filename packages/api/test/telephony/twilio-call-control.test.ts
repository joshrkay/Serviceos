/**
 * P8-013 — DefaultTwilioCallControl + maskPhone unit tests.
 *
 * Verifies the TwiML shape the adapter relies on (timeout, action,
 * <Number> wrapping), the rotation-cursor lifecycle, and the PII
 * masking helper that gates phone-number logging.
 */

import { describe, it, expect } from 'vitest';
import {
  DefaultTwilioCallControl,
  maskPhone,
} from '../../src/telephony/twilio-call-control';

describe('P8-013 maskPhone', () => {
  it('masks the middle digits of an E.164 number', () => {
    expect(maskPhone('+15125550100')).toBe('+1***0100');
  });

  it('handles two-digit country codes', () => {
    expect(maskPhone('+442012345678')).toBe('+44***5678');
  });

  it('returns a placeholder when input is null/undefined/empty', () => {
    expect(maskPhone(null)).toBe('<unknown>');
    expect(maskPhone(undefined)).toBe('<unknown>');
    expect(maskPhone('')).toBe('<unknown>');
  });

  it('falls back to last-4 masking on non-E.164 input', () => {
    expect(maskPhone('5125550100')).toBe('***0100');
  });

  it('never returns the full phone number for a normal E.164 input', () => {
    const masked = maskPhone('+15125550100');
    expect(masked).not.toContain('5125550100');
    expect(masked).not.toBe('+15125550100');
  });
});

describe('P8-013 DefaultTwilioCallControl.dialDispatcher', () => {
  it('emits a TwiML <Dial> with timeout=20 and the action URL by default', () => {
    const cc = new DefaultTwilioCallControl();
    const xml = cc.dialDispatcher('CA-1', '+15125550100', {
      actionUrl: 'https://api.test/api/telephony/dial-result?sid=abc',
    });
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<Response>');
    expect(xml).toContain('<Dial timeout="20"');
    expect(xml).toContain('action="https://api.test/api/telephony/dial-result?sid=abc"');
    expect(xml).toContain('method="POST"');
    expect(xml).toContain('<Number>+15125550100</Number>');
    expect(xml).toContain('</Dial>');
    expect(xml).toContain('</Response>');
  });

  it('honors a custom timeout', () => {
    const cc = new DefaultTwilioCallControl();
    const xml = cc.dialDispatcher('CA-1', '+15125550100', {
      actionUrl: '/x',
      timeoutSeconds: 30,
    });
    expect(xml).toContain('timeout="30"');
  });

  it('includes callerId attribute when provided', () => {
    const cc = new DefaultTwilioCallControl();
    const xml = cc.dialDispatcher('CA-1', '+15125550100', {
      actionUrl: '/x',
      callerId: '+15125559999',
    });
    expect(xml).toContain('callerId="+15125559999"');
  });

  it('omits callerId attribute when not provided', () => {
    const cc = new DefaultTwilioCallControl();
    const xml = cc.dialDispatcher('CA-1', '+15125550100', { actionUrl: '/x' });
    expect(xml).not.toContain('callerId=');
  });

  it('XML-escapes attribute and number values', () => {
    const cc = new DefaultTwilioCallControl();
    const xml = cc.dialDispatcher('CA-1', '+1&5550100', {
      actionUrl: 'https://x.test/path?q=a&b=c',
    });
    // & inside the URL must be escaped to &amp;
    expect(xml).toContain('q=a&amp;b=c');
    // & inside the phone number is also escaped (defensive)
    expect(xml).toContain('+1&amp;5550100');
  });

  it('throws when callSid is missing', () => {
    const cc = new DefaultTwilioCallControl();
    expect(() =>
      cc.dialDispatcher('', '+15125550100', { actionUrl: '/x' }),
    ).toThrow(/callSid/);
  });

  it('throws when dispatcherPhone is missing', () => {
    const cc = new DefaultTwilioCallControl();
    expect(() => cc.dialDispatcher('CA-1', '', { actionUrl: '/x' })).toThrow(
      /dispatcherPhone/,
    );
  });

  it('throws when actionUrl is missing', () => {
    const cc = new DefaultTwilioCallControl();
    expect(() =>
      cc.dialDispatcher('CA-1', '+15125550100', { actionUrl: '' }),
    ).toThrow(/actionUrl/);
  });
});

describe('P8-013 DefaultTwilioCallControl rotation cursor', () => {
  it('returns {0,0} for an unknown session', () => {
    const cc = new DefaultTwilioCallControl();
    expect(cc.getCursor('s-new')).toEqual({ index: 0, attempts: 0 });
  });

  it('advanceCursor steps forward and persists', () => {
    const cc = new DefaultTwilioCallControl();
    expect(cc.advanceCursor('s-1')).toEqual({ index: 1, attempts: 1 });
    expect(cc.advanceCursor('s-1')).toEqual({ index: 2, attempts: 2 });
    expect(cc.getCursor('s-1')).toEqual({ index: 2, attempts: 2 });
  });

  it('cursors are isolated per sessionId', () => {
    const cc = new DefaultTwilioCallControl();
    cc.advanceCursor('s-1');
    expect(cc.getCursor('s-1')).toEqual({ index: 1, attempts: 1 });
    expect(cc.getCursor('s-2')).toEqual({ index: 0, attempts: 0 });
  });

  it('clearCursor drops the entry', () => {
    const cc = new DefaultTwilioCallControl();
    cc.advanceCursor('s-1');
    cc.clearCursor('s-1');
    expect(cc.getCursor('s-1')).toEqual({ index: 0, attempts: 0 });
  });

  it('getCursor returns a fresh object each call (no aliasing)', () => {
    const cc = new DefaultTwilioCallControl();
    const a = cc.getCursor('s-x');
    a.index = 99;
    expect(cc.getCursor('s-x').index).toBe(0);
  });
});

describe('dialDispatcher with whisper', () => {
  const ctrl = new DefaultTwilioCallControl();

  it('omits url attribute when no whisperUrl is supplied (no regression)', () => {
    const twiml = ctrl.dialDispatcher('CA-1', '+15551234567', {
      actionUrl: 'https://example.com/action',
      timeoutSeconds: 20,
    });
    expect(twiml).toContain('<Number>+15551234567</Number>');
    expect(twiml).not.toContain('url="');
  });

  it('adds url attribute on <Number> when whisperUrl is supplied', () => {
    const twiml = ctrl.dialDispatcher('CA-1', '+15551234567', {
      actionUrl: 'https://example.com/action',
      whisperUrl: 'https://example.com/api/telephony/whisper/esc_abc',
      timeoutSeconds: 20,
    });
    expect(twiml).toContain(
      '<Number url="https://example.com/api/telephony/whisper/esc_abc">+15551234567</Number>',
    );
  });

  it('XML-escapes the whisperUrl', () => {
    const twiml = ctrl.dialDispatcher('CA-1', '+15551234567', {
      actionUrl: 'https://example.com/action',
      whisperUrl: 'https://example.com/whisper?id=a&b=c',
    });
    expect(twiml).toContain('url="https://example.com/whisper?id=a&amp;b=c"');
  });
});
