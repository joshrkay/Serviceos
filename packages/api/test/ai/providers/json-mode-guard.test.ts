/**
 * JSON-mode precondition guard (pure, no network).
 *
 * OpenAI rejects `response_format: { type: 'json_object' }` unless the outbound
 * messages mention "json":
 *
 *   400 'messages' must contain the word 'json' in some form, to use
 *       'response_format' of type 'json_object'
 *
 * The rejection precedes token generation, so a caller that forgets the word
 * fails 100% of the time — and a caller that swallows the error retries forever
 * (this is what drained the AI quota via the supervisor annotator sweep).
 * `ensureJsonModeMessages` is the choke-point guard, applied in both
 * OpenAI-shaped adapters at the exact point `responseFormat: 'json'` becomes
 * the provider parameter.
 *
 * The load-bearing property pinned here is that the guard is a STRICT NO-OP for
 * callers that already satisfy the precondition: it returns the same array by
 * reference, so cassette hashes and gateway cache keys cannot shift.
 */
import { describe, it, expect } from 'vitest';
import {
  JSON_MODE_SYSTEM_INSTRUCTION,
  ensureJsonModeMessages,
  messagesMentionJson,
} from '../../../src/ai/providers/openai-compatible';
import type { LLMMessage } from '../../../src/ai/gateway/gateway';

describe('messagesMentionJson', () => {
  it('is case-insensitive and matches any message, any role', () => {
    expect(messagesMentionJson([{ role: 'user', content: 'return JSON' }])).toBe(true);
    expect(messagesMentionJson([{ role: 'system', content: 'reply in json' }])).toBe(true);
    expect(messagesMentionJson([{ role: 'assistant', content: 'Json' }])).toBe(true);
    expect(
      messagesMentionJson([
        { role: 'system', content: 'you are an estimator' },
        { role: 'user', content: 'two hours labor, as jSoN please' },
      ]),
    ).toBe(true);
  });

  it('is false when no message mentions it', () => {
    expect(
      messagesMentionJson([
        { role: 'system', content: 'you are an estimator' },
        { role: 'user', content: 'two hours labor' },
      ]),
    ).toBe(false);
  });

  /**
   * The exact shape of the bug: a prose lead-in plus a `JSON.stringify`'d fact
   * object. `JSON.stringify` puts the DATA in the message, never the word.
   */
  it('is false for a stringified fact object (the original annotator prompt)', () => {
    const facts = JSON.stringify({
      proposalType: 'issue_invoice',
      actionClass: 'financial',
      summary: 'Issue invoice for $1,250.00',
      amountCents: 125_000,
      confidenceScore: 0.8,
      createdAt: '2026-06-11T11:59:00.000Z',
    });
    expect(
      messagesMentionJson([
        {
          role: 'user',
          content: 'Annotate this pending proposal for the human reviewer:\n' + facts,
        },
      ]),
    ).toBe(false);
  });

  it('finds the word inside multimodal text parts', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: 'describe the damage',
        parts: [
          { type: 'image', url: 'https://example.com/a.jpg' },
          { type: 'text', text: 'answer as JSON' },
        ],
      },
    ];
    expect(messagesMentionJson(messages)).toBe(true);
  });

  it('never throws on malformed parts', () => {
    const messages = [
      { role: 'user', content: 'hi', parts: null },
      { role: 'user', content: 'hi', parts: [null] },
    ] as unknown as LLMMessage[];
    expect(() => messagesMentionJson(messages)).not.toThrow();
    expect(messagesMentionJson(messages)).toBe(false);
  });
});

describe('ensureJsonModeMessages', () => {
  it('injects a minimal system instruction when the word is missing', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'annotate this proposal' }];
    const out = ensureJsonModeMessages(messages);

    expect(out).toEqual([
      { role: 'system', content: JSON_MODE_SYSTEM_INSTRUCTION },
      { role: 'user', content: 'annotate this proposal' },
    ]);
    // The injected instruction itself satisfies the precondition.
    expect(messagesMentionJson(out)).toBe(true);
    // Non-mutating: the caller's array is untouched.
    expect(messages).toHaveLength(1);
  });

  it('prepends rather than replacing — the caller\'s own messages all survive in order', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'you are an estimator' },
      { role: 'user', content: 'two hours labor' },
      { role: 'assistant', content: 'understood' },
    ];
    const out = ensureJsonModeMessages(messages);
    expect(out).toHaveLength(4);
    expect(out.slice(1)).toEqual(messages);
  });

  /**
   * The no-silent-change guarantee for the ~26 call sites that already work:
   * identity, not just deep equality, so nothing derived from the messages
   * array (cassette hash, gateway cache key) can shift.
   */
  it('is a STRICT no-op when the word is already present (same array by reference)', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'Return valid JSON with this shape: {...}' },
      { role: 'user', content: 'two hours labor' },
    ];
    expect(ensureJsonModeMessages(messages)).toBe(messages);
  });

  it('is a no-op when only a multimodal text part carries the word', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: 'describe the damage',
        parts: [{ type: 'text', text: 'answer as JSON' }],
      },
    ];
    expect(ensureJsonModeMessages(messages)).toBe(messages);
  });
});
