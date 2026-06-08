/**
 * Vapi REST client — assistant create/update + phone-number linking.
 *
 * Uses the global `fetch` against the Vapi REST API (no SDK dependency).
 * Off-by-default: `getVapiClient()` returns null when `VAPI_API_KEY` is
 * unset, so dev / preview / test environments behave identically to today
 * (provisioning skips the Vapi step, exactly like the Twilio worker skips
 * when its creds are absent).
 *
 * The interface is injectable so the provisioning worker and routes can be
 * unit-tested with a mock — no real Vapi calls in tests (mocks only).
 */
import type { VapiAssistantConfig } from './assistant-config';

export interface VapiClient {
  /** Create an assistant; returns its Vapi id. */
  createAssistant(config: VapiAssistantConfig): Promise<{ assistantId: string }>;
  /** Patch an existing assistant (e.g. new greeting / voice). */
  updateAssistant(assistantId: string, config: Partial<VapiAssistantConfig>): Promise<void>;
  /** Link a provisioned phone number to an assistant so inbound calls route to it. */
  linkPhoneNumber(input: { assistantId: string; phoneE164: string; twilioPhoneNumberSid?: string }): Promise<{ phoneNumberId: string }>;
}

interface VapiClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

function toAssistantBody(config: Partial<VapiAssistantConfig>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (config.name !== undefined) body.name = config.name;
  if (config.firstMessage !== undefined) body.firstMessage = config.firstMessage;
  if (config.voiceId !== undefined) {
    body.voice = { provider: '11labs', voiceId: config.voiceId };
  }
  if (config.serverUrl !== undefined) body.serverUrl = config.serverUrl;
  if (config.serverUrlSecret !== undefined) body.serverUrlSecret = config.serverUrlSecret;
  return body;
}

/** HTTP implementation of {@link VapiClient}. */
export class HttpVapiClient implements VapiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: VapiClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.vapi.ai').replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Vapi ${method} ${path} failed: ${res.status} ${text}`.trim());
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async createAssistant(config: VapiAssistantConfig): Promise<{ assistantId: string }> {
    const data = await this.request<{ id: string }>('POST', '/assistant', toAssistantBody(config));
    return { assistantId: data.id };
  }

  async updateAssistant(assistantId: string, config: Partial<VapiAssistantConfig>): Promise<void> {
    await this.request<unknown>('PATCH', `/assistant/${assistantId}`, toAssistantBody(config));
  }

  async linkPhoneNumber(input: { assistantId: string; phoneE164: string; twilioPhoneNumberSid?: string }): Promise<{ phoneNumberId: string }> {
    const data = await this.request<{ id: string }>('POST', '/phone-number', {
      provider: 'twilio',
      number: input.phoneE164,
      assistantId: input.assistantId,
      ...(input.twilioPhoneNumberSid ? { twilioPhoneNumberSid: input.twilioPhoneNumberSid } : {}),
    });
    return { phoneNumberId: data.id };
  }
}

function getApiKey(): string | undefined {
  const raw = process.env.VAPI_API_KEY;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Lazily construct the Vapi client. Returns null when no API key is
 * configured — every caller must no-op in that case (same contract as the
 * Twilio provisioning skip).
 */
export function getVapiClient(fetchFn?: typeof fetch): VapiClient | null {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  return new HttpVapiClient({
    apiKey,
    ...(process.env.VAPI_BASE_URL ? { baseUrl: process.env.VAPI_BASE_URL } : {}),
    ...(fetchFn ? { fetchFn } : {}),
  });
}

/** True iff a Vapi API key is configured. */
export function isVapiConfigured(): boolean {
  return getApiKey() !== undefined;
}
