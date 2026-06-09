import type { LLMCompletion, LLMProvider, LLMRequest, RoutingConfig } from './gateway';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async complete(model: string, request: LLMRequest): Promise<LLMCompletion> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      throw new Error(`openai request failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body.choices[0]?.message.content;
    if (!text) throw new Error('openai returned no content');
    return {
      text,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }
}

/**
 * Deterministic dev/test provider. Parses the MESSAGE line out of the intent
 * extraction prompt and answers with the same JSON contract a real model
 * would produce. Keeps the full loop runnable (and demoable) with no API key.
 */
export class StubProvider implements LLMProvider {
  readonly name = 'stub';

  async complete(_model: string, request: LLMRequest): Promise<LLMCompletion> {
    const messageMatch = /MESSAGE:\s*([\s\S]*?)\s*(?:CALLER:|$)/.exec(request.prompt);
    const callerMatch = /CALLER:\s*(\S+)/.exec(request.prompt);
    const message = (messageMatch?.[1] ?? '').trim();
    const caller = callerMatch?.[1];
    const intent = extractStubIntent(message, caller);
    return { text: JSON.stringify(intent), inputTokens: 50, outputTokens: 50 };
  }
}

interface StubIntent {
  type: string | null;
  payload?: Record<string, unknown>;
  summary?: string;
  confidence?: number;
}

function parseMoney(raw: string): number {
  return Math.round(Number(raw.replace(/[$,]/g, '')) * 100);
}

function nextBusinessMorning(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(13, 0, 0, 0); // 9am ET
  return date.toISOString();
}

function extractStubIntent(message: string, caller?: string): StubIntent {
  const invoice = /invoice\s+(.+?)\s+\$?([\d,]+(?:\.\d{1,2})?)\s+for\s+(.+)/i.exec(message);
  if (invoice) {
    const [, name, amount, description] = invoice;
    const cents = parseMoney(amount!);
    return {
      type: 'draft_invoice',
      payload: {
        customerName: name!.trim(),
        lineItems: [{ description: description!.trim(), quantityHundredths: 100, unitPriceCents: cents }],
      },
      summary: `Draft invoice for ${name!.trim()}: $${(cents / 100).toFixed(2)} (${description!.trim()})`,
      confidence: 0.92,
    };
  }

  const newCustomer = /(?:new customer|add customer)\s+(.+?)\s+(\+?[\d-]{7,15})/i.exec(message);
  if (newCustomer) {
    const [, name, phone] = newCustomer;
    return {
      type: 'create_customer',
      payload: { name: name!.trim(), phone: phone!.trim() },
      summary: `Add customer ${name!.trim()} (${phone!.trim()})`,
      confidence: 0.95,
    };
  }

  const booking = /(?:book|schedule)\s+(.+?)\s+for\s+(.+)/i.exec(message);
  if (booking) {
    const [, name, work] = booking;
    return {
      type: 'schedule_job',
      payload: {
        customerName: name!.trim(),
        customerPhone: caller,
        title: work!.trim(),
        startsAt: nextBusinessMorning(),
        durationMinutes: 60,
      },
      summary: `Book ${name!.trim()} tomorrow 9am: ${work!.trim()}`,
      confidence: 0.85,
    };
  }

  // A customer describing a problem -> propose booking them in.
  const trouble = /(broken|leaking|leak|not working|no heat|no cooling|repair|fix|quote)/i.exec(message);
  if (trouble && caller) {
    return {
      type: 'schedule_job',
      payload: {
        customerName: `Caller ${caller}`,
        customerPhone: caller,
        title: `Service call: ${message.slice(0, 120)}`,
        startsAt: nextBusinessMorning(),
        durationMinutes: 60,
      },
      summary: `Book caller ${caller} tomorrow 9am (${trouble[1]!.toLowerCase()} reported)`,
      confidence: 0.7,
    };
  }

  return { type: null };
}

export function defaultRouting(hasOpenAI: boolean): RoutingConfig {
  const provider = hasOpenAI ? 'openai' : 'stub';
  return {
    intent_extraction: {
      provider,
      model: hasOpenAI ? 'gpt-4o-mini' : 'stub-1',
      costPer1kInputMicrocents: 15_000,
      costPer1kOutputMicrocents: 60_000,
      timeoutMs: 20_000,
    },
  };
}
