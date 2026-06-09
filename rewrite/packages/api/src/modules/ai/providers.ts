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
    const messageMatch = /MESSAGE:\s*([\s\S]*?)\s*(?:CALLER:|NOW:|$)/.exec(request.prompt);
    const callerMatch = /CALLER:\s*(\S+)/.exec(request.prompt);
    const nowMatch = /NOW:\s*(\S+)/.exec(request.prompt);
    const message = (messageMatch?.[1] ?? '').trim();
    const caller = callerMatch?.[1];
    const now = nowMatch ? new Date(nowMatch[1]!) : new Date();
    const intent = extractStubIntent(message, caller, now);
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

// The stub treats clock times as US Eastern (UTC-4), matching the demo
// tenant. The real provider resolves times against TENANT_TIMEZONE from the
// prompt context.
const ET_OFFSET_HOURS = 4;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface RequestedTime {
  iso: string;
  label: string;
}

/**
 * Derives the caller's requested visit time from the message. Understands
 * relative days (today / tomorrow / weekday names), parts of day
 * (morning 9am, afternoon 1pm, evening 5pm, noon) and explicit clock times
 * ("at 3pm", "around 10:30 am"). Defaults to tomorrow morning.
 */
export function parseRequestedTime(message: string, now: Date = new Date()): RequestedTime {
  const lower = message.toLowerCase();

  let dayOffset = 1;
  let dayLabel = 'tomorrow';
  if (/\btoday\b/.test(lower)) {
    dayOffset = 0;
    dayLabel = 'today';
  } else if (/\btomorrow\b/.test(lower)) {
    dayOffset = 1;
    dayLabel = 'tomorrow';
  } else {
    for (let day = 0; day < WEEKDAYS.length; day += 1) {
      if (new RegExp(`\\b${WEEKDAYS[day]}\\b`).test(lower)) {
        const todayDow = new Date(now.getTime() - ET_OFFSET_HOURS * 3_600_000).getUTCDay();
        dayOffset = (day - todayDow + 7) % 7 || 7;
        dayLabel = WEEKDAYS[day]!.charAt(0).toUpperCase() + WEEKDAYS[day]!.slice(1);
        break;
      }
    }
  }

  let hour = 9;
  let minute = 0;
  let timeLabel = 'morning';
  const explicit = /\b(?:at|around|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(lower);
  if (explicit) {
    hour = (Number(explicit[1]) % 12) + (explicit[3] === 'pm' ? 12 : 0);
    minute = Number(explicit[2] ?? 0);
    timeLabel = `${explicit[1]}${explicit[2] ? `:${explicit[2]}` : ''}${explicit[3]}`;
  } else if (/\bnoon\b/.test(lower)) {
    hour = 12;
    timeLabel = 'noon';
  } else if (/\bafternoon\b/.test(lower)) {
    hour = 13;
    timeLabel = 'afternoon';
  } else if (/\b(evening|tonight|after work)\b/.test(lower)) {
    hour = 17;
    timeLabel = 'evening';
  } else if (/\bmorning\b/.test(lower)) {
    hour = 9;
    timeLabel = 'morning';
  }

  const etNow = new Date(now.getTime() - ET_OFFSET_HOURS * 3_600_000);
  const date = new Date(Date.UTC(etNow.getUTCFullYear(), etNow.getUTCMonth(), etNow.getUTCDate() + dayOffset));
  date.setUTCHours(hour + ET_OFFSET_HOURS, minute, 0, 0);
  return { iso: date.toISOString(), label: `${dayLabel} ${timeLabel}` };
}

/** "Hi, this is Janet Miller" -> "Janet Miller" */
export function parseCallerName(message: string): string | null {
  const match = /\b(?:this is|my name is|it'?s)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/.exec(message);
  return match ? match[1]! : null;
}

function extractStubIntent(message: string, caller?: string, now: Date = new Date()): StubIntent {
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
    const requested = parseRequestedTime(message, now);
    return {
      type: 'schedule_job',
      payload: {
        customerName: name!.trim(),
        customerPhone: caller,
        title: work!.trim(),
        startsAt: requested.iso,
        durationMinutes: 60,
      },
      summary: `Book ${name!.trim()} ${requested.label}: ${work!.trim()}`,
      confidence: 0.85,
    };
  }

  // A customer describing a problem -> propose booking them in.
  const trouble = /(broken|leaking|leak|not working|no heat|no cooling|repair|fix|quote)/i.exec(message);
  if (trouble && caller) {
    const requested = parseRequestedTime(message, now);
    const callerName = parseCallerName(message);
    return {
      type: 'schedule_job',
      payload: {
        customerName: callerName ?? `Caller ${caller}`,
        customerPhone: caller,
        title: `Service call: ${message.slice(0, 120)}`,
        startsAt: requested.iso,
        durationMinutes: 60,
      },
      summary: `Book ${callerName ?? `caller ${caller}`} ${requested.label} (${trouble[1]!.toLowerCase()} reported)`,
      confidence: callerName ? 0.8 : 0.7,
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
