/**
 * U1 — LLM gateway multimodal (image) support.
 *
 * Verifies:
 * 1. validateLLMRequest accepts multimodal content-block messages (text + image).
 * 2. String content stays valid (back-compat).
 * 3. Image blocks without a URL, empty content arrays, and unknown block
 *    types are rejected.
 * 4. redactMessagesForSnapshot strips image URLs but preserves text and
 *    plain-string messages (no PII at rest in ai_run snapshots).
 */
import { describe, it, expect } from 'vitest';
import {
  validateLLMRequest,
  redactMessagesForSnapshot,
  type LLMRequest,
  type LLMMessage,
} from '../../../src/ai/gateway/gateway';

function baseRequest(messages: LLMMessage[]): LLMRequest {
  return { taskType: 'draft_estimate', messages };
}

describe('U1 gateway multimodal — validateLLMRequest', () => {
  it('accepts a multimodal message with text + image_url blocks', () => {
    const errors = validateLLMRequest(
      baseRequest([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is wrong with this fixture?' },
            { type: 'image_url', image_url: { url: 'https://example.com/leak.jpg' } },
          ],
        },
      ]),
    );
    expect(errors).toEqual([]);
  });

  it('keeps plain string content valid (back-compat)', () => {
    const errors = validateLLMRequest(
      baseRequest([{ role: 'user', content: 'just text' }]),
    );
    expect(errors).toEqual([]);
  });

  it('rejects an image block with a missing/empty url', () => {
    const errors = validateLLMRequest(
      baseRequest([
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: '' } }],
        },
      ]),
    );
    expect(errors.some((e) => e.includes('image_url.url is required'))).toBe(true);
  });

  it('rejects an empty content-block array', () => {
    const errors = validateLLMRequest(
      baseRequest([{ role: 'user', content: [] }]),
    );
    expect(errors.some((e) => e.includes('content array must be non-empty'))).toBe(true);
  });

  it('rejects an unknown block type', () => {
    const errors = validateLLMRequest(
      baseRequest([
        // @ts-expect-error — deliberately invalid block type
        { role: 'user', content: [{ type: 'audio', data: 'x' }] },
      ]),
    );
    expect(errors.some((e) => e.includes('unknown block type'))).toBe(true);
  });
});

describe('U1 gateway multimodal — redactMessagesForSnapshot', () => {
  it('redacts image URLs but preserves text blocks', () => {
    const redacted = redactMessagesForSnapshot([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see photo' },
          { type: 'image_url', image_url: { url: 'https://cdn/leak-with-token.jpg?sig=secret' } },
        ],
      },
    ]);
    const content = redacted[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'see photo' });
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: '[redacted-image]' } });
  });

  it('passes plain-string messages through unchanged', () => {
    const messages: LLMMessage[] = [{ role: 'system', content: 'be helpful' }];
    expect(redactMessagesForSnapshot(messages)).toEqual(messages);
  });
});
