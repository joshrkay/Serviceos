import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { whisperRouter } from '../../src/telephony/whisper-route';
import { WhisperCache } from '../../src/telephony/whisper-cache';

describe('GET /api/telephony/whisper/:escalationId', () => {
  it('returns TwiML <Say> with the cached whisper text', async () => {
    const cache = new WhisperCache();
    cache.set('esc_abc', 'Incoming call from Sarah Chen.');
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));

    const res = await request(app).get('/api/telephony/whisper/esc_abc');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.text).toContain('<Say>');
    expect(res.text).toContain('Incoming call from Sarah Chen.');
  });

  it('returns 200 with empty <Response> when escalationId is unknown (caller still connects)', async () => {
    const cache = new WhisperCache();
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));
    const res = await request(app).get('/api/telephony/whisper/nonexistent');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
  });

  it('escapes XML in the whisper text', async () => {
    const cache = new WhisperCache();
    cache.set('esc_xml', 'Caller said: <urgent> & "rush"');
    const app = express();
    app.use('/api/telephony', whisperRouter({ whisperCache: cache }));
    const res = await request(app).get('/api/telephony/whisper/esc_xml');
    expect(res.text).not.toContain('<urgent>');
    expect(res.text).toContain('&lt;urgent&gt;');
    expect(res.text).toContain('&amp;');
    expect(res.text).toContain('&quot;');
  });
});
