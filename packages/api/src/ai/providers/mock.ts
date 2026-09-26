import { messagesContainImage, type LLMProvider, type LLMRequest, type LLMResponse } from '../gateway/gateway';
import { matchUpdateJobPriorityPhrase } from '../orchestration/intent-classifier';
import { UNTRUSTED_CONTENT_BLOCK_BEGIN, UNTRUSTED_CONTENT_BLOCK_END } from '../untrusted-content';

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

/**
 * #894 — an S1 caller's utterance reaches `classify_intent` wrapped in the I13
 * untrusted-content fence (`classifierUserContent` →
 * `buildUntrustedContentSection`): BEGIN marker, a label line, the caller's
 * words, the hardening line, END marker. A real model classifies the quoted
 * words, not the fence's own label and hardening text — so must this script,
 * or the hardening line's quoted examples ("ignore previous instructions")
 * become an extracted name and the markers bleed into multi-line matches.
 * Text with no fence (every owner surface) is returned unchanged.
 *
 * Anchored: only a message that IS a fence — starts with the BEGIN marker
 * line and ends with the END marker line — is unwrapped, so owner text that
 * merely quotes a marker string somewhere is never sliced.
 */
function fencedUtteranceOrText(text: string): string {
  const trimmed = text.trim();
  if (
    !trimmed.startsWith(`${UNTRUSTED_CONTENT_BLOCK_BEGIN}\n`) ||
    !trimmed.endsWith(`\n${UNTRUSTED_CONTENT_BLOCK_END}`)
  ) {
    return text;
  }
  // [label line, ...words, hardening line]
  const lines = trimmed
    .slice(UNTRUSTED_CONTENT_BLOCK_BEGIN.length + 1, trimmed.length - UNTRUSTED_CONTENT_BLOCK_END.length - 1)
    .split('\n');
  if (lines.length < 3) return text;
  return lines.slice(1, -1).join('\n');
}

/**
 * Concatenated content of every `system`-role message, in order. Several
 * task prompts (notably `brand_voice_v1` — `buildBrandVoicePrompt`,
 * ai/brand-voice/prompts.ts) render tenant-specific data (business name,
 * tone) into a SYSTEM message, never the last user message `lastUserText`
 * reads (#1132).
 */
function systemText(request: LLMRequest): string {
  const messages = request.messages ?? [];
  return messages
    .filter((m) => m?.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .join('\n');
}

/**
 * Drop the first top-level `{...}` run from `text`. Several prompts embed a
 * `JSON.stringify(...)` context blob inline in otherwise natural-language
 * text (e.g. `MmsEstimateTaskHandler.buildUserContent`:
 * `Customer/property: {"customerId":"<uuid>",...}`). `extractName`'s
 * heuristics must never treat a JSON KEY or VALUE from that blob as a
 * captured name (#1154 item 1) — depth-counted so nested braces (an object
 * value) still remove the whole blob, not just up to the first `}`.
 */
function stripJsonBlobs(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return text;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(0, start) + text.slice(i + 1);
    }
  }
  // Unterminated (shouldn't happen for well-formed JSON.stringify output) —
  // drop the rest defensively rather than risk scanning into it.
  return text.slice(0, start);
}

function extractName(text: string): string | undefined {
  const clean = stripJsonBlobs(text);
  // Prefer explicit "named X" / "name is X" so "customer named Jane" does not
  // capture the word "named" (case-insensitive [A-Z] would match it).
  const named = clean.match(
    /\b(?:named|name\s+is)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,3})/,
  );
  if (named?.[1]) return named[1].trim();
  // `,?` covers the common spoken form "Add a new customer, Mario Delingo,
  // 412 Oak Street" — without it the comma blocks the match and the mock
  // falls back to the literal 'New Customer', which would make any corpus
  // script using that phrasing grade a placeholder instead of the real name.
  const forCustomer = clean.match(
    /\b(?:customer|for)\s*,?\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,3})/,
  );
  if (forCustomer?.[1]) return forCustomer[1].trim();
  const quoted = clean.match(/["']([^"']{2,80})["']/);
  return quoted?.[1]?.trim();
}

function extractEmail(text: string): string | undefined {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
}

function extractPhone(text: string): string | undefined {
  return text.match(/\+?\d[\d\s().-]{7,}\d/)?.[0]?.replace(/\s+/g, ' ').trim();
}

/**
 * Street address stated on a create_customer utterance ("..., 412 Oak
 * Street, Scottsdale, 85254", "He's at 34 Quarry Street"). Matches a house
 * number followed by a street name and a street-type word, then greedily
 * takes any trailing ", city[, state][, zip]" run.
 *
 * This exists because the voice-quality corpus replays THIS mock, not a real
 * model — a create_customer field the mock cannot produce is a field the
 * corpus can never grade, so it would sail through the launch gate exactly
 * as the dropped address did.
 */
const STREET_TYPES =
  'street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|circle|cir|place|pl|terrace|ter|parkway|pkwy|highway|hwy';

function extractAddress(text: string): string | undefined {
  const re = new RegExp(
    // house number + street words + street type, then optional ", ..." tail
    `\\b(\\d+\\s+(?:[A-Za-z0-9.'-]+\\s+){0,4}?(?:${STREET_TYPES})\\b(?:\\s*,\\s*[A-Za-z0-9.'-]+(?:\\s+[A-Za-z0-9.'-]+){0,3}){0,3})`,
    'i',
  );
  const match = text.match(re);
  if (!match?.[1]) return undefined;
  // Trim a trailing sentence period and any stray separator.
  return match[1].replace(/[\s,.]+$/, '').trim();
}

/** The fixed first line of confirmIntent's yes/no prompt. */
const CONFIRM_PROMPT_HEAD = "Classify the caller's response as YES or NO.";

function isConfirmIntentRequest(request: LLMRequest, text: string): boolean {
  return request.metadata?.skill === 'confirm_intent' || text.startsWith(CONFIRM_PROMPT_HEAD);
}

/**
 * Affirmative phrases a hermetic confirm accepts. CLOSED on purpose: the
 * caller's whole reply must be made of these (plus politeness fillers) to
 * count as a yes. Anything else — a "no", a correction, a "yes but…", a
 * hedge — is answered "no", which is exactly the rule the confirm prompt
 * gives the real model ("Ambiguous responses → NO").
 */
const CONFIRM_AFFIRMATIVES: readonly string[] = [
  'yes',
  'yeah',
  'yep',
  'yup',
  'correct',
  "that's correct",
  'that is correct',
  "that's right",
  'that is right',
  'right',
  'exactly',
  'sure',
  'sounds good',
  'go ahead',
  'ok',
  'okay',
  'perfect',
  'that works',
  'affirmative',
  'sí',
  'si',
  'correcto',
  'claro',
];
const CONFIRM_FILLERS: readonly string[] = ['please', 'thanks', 'thank you'];

/** Longest first, so "that is right" is consumed before "right". */
const CONFIRM_PHRASES = [...CONFIRM_AFFIRMATIVES, ...CONFIRM_FILLERS].sort(
  (a, b) => b.length - a.length,
);

function callerSaidInConfirmPrompt(text: string): string {
  const match = text.match(/^The caller said: "([\s\S]*)"$/m);
  return match?.[1] ?? '';
}

/** Deterministic yes/no for confirmIntent's prompt (#1119). */
function scriptConfirmAnswer(text: string): { answer: 'yes' | 'no'; reasoning: string } {
  let rest = callerSaidInConfirmPrompt(text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let sawAffirmative = false;
  while (rest.length > 0) {
    const phrase = CONFIRM_PHRASES.find((p) => rest === p || rest.startsWith(`${p} `));
    if (!phrase) break;
    if (CONFIRM_AFFIRMATIVES.includes(phrase)) sawAffirmative = true;
    rest = rest.slice(phrase.length).trim();
  }
  return rest.length === 0 && sawAffirmative
    ? { answer: 'yes', reasoning: 'hermetic: reply is a clear affirmative' }
    : { answer: 'no', reasoning: 'hermetic: negative, correction or ambiguous reply' };
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

  if (taskType === 'update_job') {
    // #1154 item 2 — UpdateJobTaskHandler.buildUserMessage sends
    // `Transcript: <operator words>` (+ optional `Classifier hints: ...`).
    // The router's `matchUpdateJobPriorityPhrase` (intent-classifier.ts) may
    // already have deterministically recognized "mark the X job as
    // <priority> priority" at the classify step WITHOUT a gateway call, but
    // drafting still needs THIS separate `update_job` gateway call — reuse
    // the SAME matcher against the request's own transcript so the two
    // never disagree, and so the draft carries at least one changeable
    // field (updateJobPayloadSchema's "at least one field to change"
    // refine — proposals/contracts.ts — otherwise rejects it; jobId itself
    // comes from the router's entity resolution, not from this response).
    const marker = 'Transcript: ';
    const idx = text.indexOf(marker);
    const transcript = idx >= 0 ? text.slice(idx + marker.length).split('\n')[0] : text;
    const priorityPhrase = matchUpdateJobPriorityPhrase(transcript);
    if (priorityPhrase) {
      const priority = transcript.match(/\b(low|normal|high|urgent)\b\s+priority/i)?.[1]?.toLowerCase();
      return JSON.stringify({
        jobReference: priorityPhrase.jobReference,
        ...(priority ? { priority } : {}),
        confidence_score: 0.9,
      });
    }
    // No deterministic match (a status/title/description edit, or free-form
    // phrasing) — fall through to the generic catch-all below; only the
    // anchored priority phrasing is scripted deterministically here.
  }

  if (taskType === 'brand_voice_v1') {
    // #1132 — composeBrandVoiceMessage (ai/brand-voice/composer.ts) treats
    // response.content as the LITERAL customer-facing text (responseFormat:
    // 'text', never JSON), and buildBrandVoicePrompt (ai/brand-voice
    // /prompts.ts) renders the tenant's tone — including the business name —
    // into a SYSTEM message (renderToneAuthority), not the last user
    // message. Read the system text (never just `text`/lastUserText) so a
    // hermetic draft is tenant-voiced instead of the generic catch-all, and
    // return plain text, not JSON.
    const system = systemText(request);
    const businessName = system.match(/business name is "([^"]+)"/i)?.[1];
    const firstPerson = /first person as "i"/i.test(system) ? 'I' : 'we';
    const signoff = system.match(/Sign off with: "([^"]+)"/i)?.[1];
    // renderContext (ai/brand-voice/prompts.ts) renders caller-supplied
    // context as `- key: value` lines in the LAST user message.
    const customerName = text.match(/-\s*customerName:\s*([^\n]+)/i)?.[1]?.trim();
    const greeting = customerName ? `Hi ${customerName}, ` : '';
    const businessBit = businessName ? `this is ${businessName} — ` : '';
    const raw =
      `${greeting}${businessBit}${firstPerson === 'I' ? "I'm" : "we're"} ` +
      `sorry for the schedule change and will follow up shortly with next steps.` +
      (signoff ? ` ${signoff}` : '');
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  if (taskType === 'classify_intent' && isConfirmIntentRequest(request, text)) {
    // #1119 — confirmIntent (ai/skills/confirm-intent.ts) rides the
    // `classify_intent` task type. Before this branch the confirm prompt fell
    // into the intent script below, which answers `{intentType,...}` with no
    // `answer` field — so `parseYesNo` returned null and EVERY hermetic
    // confirm turn, "Yes, that is right" included, became a correction.
    return JSON.stringify(scriptConfirmAnswer(text));
  }

  if (taskType === 'classify_intent' || taskType.startsWith('classify')) {
    // #894 — script from the caller's words inside the fence (unchanged for
    // an unfenced owner utterance). Deliberately shadows the outer text/lower.
    const text = fencedUtteranceOrText(lastUserText(request));
    const lower = text.toLowerCase();
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
          ...(extractAddress(text) ? { address: extractAddress(text) } : {}),
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

  // ── #1173 (lane O6) — hermetic VISION estimate ─────────────────────────
  // A draft_estimate request that carries image parts (an Assistant chat
  // photo → EstimateTaskHandler) is scripted as a photo-diagnosed line, so a
  // hermetic run can tell a photo-informed draft from a text-only one. Kept
  // as its own delimited branch, ahead of the generic estimate branch below,
  // so edits to the surrounding task-type branches do not collide with it.
  if (taskType === 'draft_estimate' && messagesContainImage(request.messages ?? [])) {
    const photos = (request.messages ?? []).reduce(
      (n, m) => n + (Array.isArray(m.parts) ? m.parts.filter((p) => p?.type === 'image').length : 0),
      0,
    );
    const name = extractName(text);
    return JSON.stringify({
      lineItems: [
        {
          description: name ? `Repair shown in photo for ${name}` : 'Repair shown in photo',
          quantity: 1,
          // Integer cents, like the branch below. No `catalogItemId: null`:
          // the draft_estimate contract types it as a string when present, so
          // the grounding pass (not the model) decides the catalog link.
          unitPrice: 15000,
        },
      ],
      confidence_score: 0.8,
      summary: text.slice(0, 160) || 'Photo estimate',
      notes: `Hermetic mock vision draft from ${photos} photo(s) — review prices before approving.`,
    });
  }
  // ── end #1173 ────────────────────────────────────────────────────────────

  if (
    taskType === 'draft_estimate' ||
    taskType.includes('estimate') ||
    taskType === 'draft_invoice' ||
    taskType.includes('invoice')
  ) {
    const label = taskType.includes('invoice') ? 'Service work' : 'Service estimate';
    // Estimate/invoice draft handlers expect `unitPrice` in integer cents
    // (see EstimateTaskHandler / InvoiceTaskHandler system prompts). No
    // `catalogItemId` key here — a real model never emits one (see
    // `validVisionJson` in mms-estimate-task.test.ts): it is ONLY ever
    // attached later by `groundLineItemPricing` on a catalog match. A
    // hardcoded `catalogItemId: null` broke `draft_estimate`'s Zod contract
    // (`catalogItemId: z.string().uuid().optional()` rejects an explicit
    // `null`) for any tenant with no matching catalog item, independent of
    // the description text (#1154 item 1).
    return JSON.stringify({
      lineItems: [
        {
          description: extractName(text) ? `${label} for ${extractName(text)}` : label,
          quantity: 1,
          unitPrice: 15000,
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
