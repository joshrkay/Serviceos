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

  // #1575 — https://docs.vapi.ai/api-reference/phone-numbers/delete
  // (DELETE https://api.vapi.ai/phone-number/{id}, bearer auth, 200 + the deleted resource).
  it('deletePhoneNumber DELETEs /phone-number/:id with bearer auth', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ id: 'pn_old' }));
    const client = new HttpVapiClient({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    await client.deletePhoneNumber('pn_old');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.vapi.ai/phone-number/pn_old');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(init.body).toBeUndefined();
  });

  it('deletePhoneNumber treats 404 as already deleted (idempotent cleanup)', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ message: 'Not Found' }, 404));
    const client = new HttpVapiClient({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.deletePhoneNumber('pn_gone')).resolves.toBeUndefined();
  });

  it('deletePhoneNumber throws on other failures', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ message: 'boom' }, 500));
    const client = new HttpVapiClient({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.deletePhoneNumber('pn_old')).rejects.toThrow(/Vapi DELETE \/phone-number\/pn_old failed: 500/);
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
