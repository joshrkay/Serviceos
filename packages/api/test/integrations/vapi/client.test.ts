import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpVapiClient, getVapiClient, isVapiConfigured } from '../../../src/integrations/vapi/client';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('HttpVapiClient (mocked fetch — no real Vapi calls)', () => {
  it('createAssistant POSTs /assistant with the 11labs voice + bearer auth', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ id: 'asst_1' }));
    const client = new HttpVapiClient({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    const res = await client.createAssistant({ name: 'A', firstMessage: 'hi', voiceId: 'v1', serverUrl: 'u', serverUrlSecret: 's' });
    expect(res).toEqual({ assistantId: 'asst_1' });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.vapi.ai/assistant');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body as string);
    expect(body.voice).toEqual({ provider: '11labs', voiceId: 'v1' });
    expect(body.serverUrlSecret).toBe('s');
    expect(body.firstMessage).toBe('hi');
  });

  it('updateAssistant PATCHes /assistant/:id', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}, 200));
    const client = new HttpVapiClient({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    await client.updateAssistant('asst_1', { firstMessage: 'new greeting' });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vapi.ai/assistant/asst_1');
    expect(init.method).toBe('PATCH');
  });

  it('linkPhoneNumber POSTs /phone-number with assistant + number', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ id: 'pn_1' }));
    const client = new HttpVapiClient({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    const res = await client.linkPhoneNumber({ assistantId: 'asst_1', phoneE164: '+15125550000', twilioPhoneNumberSid: 'PN9' });
    expect(res).toEqual({ phoneNumberId: 'pn_1' });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.vapi.ai/phone-number');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ provider: 'twilio', number: '+15125550000', assistantId: 'asst_1', twilioPhoneNumberSid: 'PN9' });
  });

  it('throws on a non-2xx response', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ error: 'bad' }, 400));
    const client = new HttpVapiClient({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.createAssistant({ name: 'A', firstMessage: 'h', voiceId: 'v' })).rejects.toThrow(/Vapi POST/);
  });
});

describe('getVapiClient / isVapiConfigured (off-by-default)', () => {
  const prev = process.env.VAPI_API_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.VAPI_API_KEY;
    else process.env.VAPI_API_KEY = prev;
  });

  it('returns null and reports not-configured without VAPI_API_KEY', () => {
    delete process.env.VAPI_API_KEY;
    expect(getVapiClient()).toBeNull();
    expect(isVapiConfigured()).toBe(false);
  });

  it('constructs a client when the key is set', () => {
    process.env.VAPI_API_KEY = 'k';
    expect(getVapiClient()).not.toBeNull();
    expect(isVapiConfigured()).toBe(true);
  });
});
