import type { LLMProvider, LLMRequest, LLMResponse } from '../gateway/gateway';

/**
 * Deterministic mock provider for unit tests and hermetic local/dev.
 * Returns configurable responses without any network calls.
 *
 * When `hermetic` is true (no-key app boot), responses are scripted from
 * `taskType` + the last user message so assistant/voice paths can create
 * real proposals without a paid provider key. Tests that pass an explicit
 * `defaultResponse` keep the legacy constant-response behavior unless they
 * opt into hermetic mode.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';

  private responses: Map<string, string> = new Map();
  private callLog: LLMRequest[] = [];
  private defaultResponse: string;
  private readonly hermetic: boolean;

  constructor(defaultResponse = '{"mock": true}', options?: { hermetic?: boolean }) {
    this.defaultResponse = defaultResponse;
    this.hermetic = options?.hermetic === true;
  }

  /** Prime a response for a specific model */
  setResponse(model: string, content: string): void {
    this.responses.set(model, content);
  }

  /** Set the fallback response for any model */
  setDefaultResponse(content: string): void {
    this.defaultResponse = content;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.callLog.push(request);
    const model = request.model ?? 'mock-model';
    if (this.responses.has(model)) {
      return this.buildResponse(model, this.responses.get(model)!);
    }
    if (this.hermetic) {
      return this.buildResponse(model, scriptHermeticResponse(request));
    }
    return this.buildResponse(model, this.defaultResponse);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getCalls(): LLMRequest[] {
    return [...this.callLog];
  }

  reset(): void {
    this.callLog = [];
    this.responses.clear();
  }

  private buildResponse(model: string, content: string): LLMResponse {
    return {
      content,
      model,
      provider: this.name,
      latencyMs: 1,
      tokenUsage: { input: 10, output: 10, total: 20 },
    };
  }
}

function lastUserText(request: LLMRequest): string {
  const messages = request.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
}

function extractName(text: string): string | undefined {
  // Prefer explicit "named X" / "name is X" so "customer named Jane" does not
  // capture the word "named" (case-insensitive [A-Z] would match it).
  const named = text.match(
    /\b(?:named|name\s+is)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,3})/,
  );
  if (named?.[1]) return named[1].trim();
  const forCustomer = text.match(
    /\b(?:customer|for)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,3})/,
  );
  if (forCustomer?.[1]) return forCustomer[1].trim();
  const quoted = text.match(/["']([^"']{2,80})["']/);
  return quoted?.[1]?.trim();
}

function extractEmail(text: string): string | undefined {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
}

function extractPhone(text: string): string | undefined {
  return text.match(/\+?\d[\d\s().-]{7,}\d/)?.[0]?.replace(/\s+/g, ' ').trim();
}

/**
 * Scripted hermetic completions used when AI_PROVIDER_API_KEY is unset.
 * Intentionally conservative: only operator CRM/money drafting intents that
 * already have server-side proposal handlers.
 */
export function scriptHermeticResponse(request: LLMRequest): string {
  const taskType = request.taskType ?? '';
  const text = lastUserText(request);
  const lower = text.toLowerCase();

  if (taskType === 'transcription_correction') {
    // Echo the raw transcript back verbatim instead of falling through to
    // the generic `{"ok":true,"mock":true,...}` catch-all below. That blob
    // is prose-shaped JSON that could pass length-floor checks and get
    // mistaken for a real (if unhelpful) correction; echoing the raw text
    // lets hermetic dev exercise the correction seam harmlessly while
    // staying trivially inert. correctTranscript()'s user prompt is either
    // `Raw transcript: ${raw}` or `Tenant-specific vocabulary (...): ...\n\n
    // Raw transcript: ${raw}` — pull everything after the last marker.
    const marker = 'Raw transcript: ';
    const idx = text.lastIndexOf(marker);
    return idx >= 0 ? text.slice(idx + marker.length) : text;
  }

  if (taskType === 'classify_intent' || taskType.startsWith('classify')) {
    if (
      /\b(create|add|new)\b.*\bcustomer\b/.test(lower) ||
      /\bcustomer\b.*\b(named|name)\b/.test(lower)
    ) {
      return JSON.stringify({
        intentType: 'create_customer',
        confidence: 0.92,
        extractedEntities: {
          displayName: extractName(text) ?? 'New Customer',
          ...(extractEmail(text) ? { email: extractEmail(text) } : {}),
          ...(extractPhone(text) ? { phone: extractPhone(text) } : {}),
        },
      });
    }
    if (/\b(draft|create|prepare|make)\b.*\bestimate\b/.test(lower) || /\bestimate\b.*\bfor\b/.test(lower)) {
      return JSON.stringify({
        intentType: 'draft_estimate',
        confidence: 0.9,
        extractedEntities: {
          customerName: extractName(text) ?? 'Customer',
          summary: text.slice(0, 160),
        },
      });
    }
    if (/\b(draft|create|prepare|make|issue)\b.*\binvoice\b/.test(lower) || /\binvoice\b.*\bfor\b/.test(lower)) {
      return JSON.stringify({
        intentType: 'create_invoice',
        confidence: 0.9,
        extractedEntities: {
          customerName: extractName(text) ?? 'Customer',
          summary: text.slice(0, 160),
        },
      });
    }
    return JSON.stringify({ intentType: 'unknown', confidence: 0.2 });
  }

  if (
    taskType === 'draft_estimate' ||
    taskType.includes('estimate') ||
    taskType === 'draft_invoice' ||
    taskType.includes('invoice')
  ) {
    const label = taskType.includes('invoice') ? 'Service work' : 'Service estimate';
    // Estimate/invoice draft handlers expect `unitPrice` in integer cents
    // (see EstimateTaskHandler / InvoiceTaskHandler system prompts).
    return JSON.stringify({
      lineItems: [
        {
          description: extractName(text) ? `${label} for ${extractName(text)}` : label,
          quantity: 1,
          unitPrice: 15000,
          catalogItemId: null,
        },
      ],
      confidence_score: 0.82,
      summary: text.slice(0, 160) || label,
      notes: 'Hermetic mock draft — review prices before approving.',
    });
  }

  if (taskType.startsWith('assistant') || taskType.includes('chat') || taskType === '') {
    return JSON.stringify({
      content:
        'I drafted what I could from that request. If a proposal card appeared, review and approve it to apply the change.',
      autoApplied: false,
      proposal: null,
    });
  }

  // Graders / extractors / unknown task types: valid empty JSON keeps Zod paths
  // from hard-failing while remaining obviously synthetic.
  return JSON.stringify({
    ok: true,
    mock: true,
    taskType,
    note: 'hermetic-mock',
  });
}
