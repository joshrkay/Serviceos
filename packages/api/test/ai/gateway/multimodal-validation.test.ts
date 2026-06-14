/**
 * F-A U1 — multimodal request validation.
 *
 * The text-only path must be unchanged; image parts are accepted only on
 * user messages with a valid http(s) or data:image base64 URL.
 */
import { describe, it, expect } from 'vitest';
import { validateLLMRequest, messagesContainImage } from '../../../src/ai/gateway/gateway';
import type { LLMRequest, LLMMessage } from '../../../src/ai/gateway/gateway';

function req(messages: LLMMessage[]): LLMRequest {
  return { taskType: 'draft_estimate', messages };
}

// Build a structurally-invalid message to exercise untrusted-input handling.
function badMsg(parts: unknown): LLMMessage {
  return { role: 'user', content: 'x', parts } as unknown as LLMMessage;
}

describe('validateLLMRequest — multimodal parts', () => {
  it('accepts a user message with text content and an https image part', () => {
    const errors = validateLLMRequest(
      req([
        {
          role: 'user',
          content: 'What work is needed here?',
          parts: [{ type: 'image', url: 'https://example.com/leak.jpg' }],
        },
      ]),
    );
    expect(errors).toEqual([]);
  });

  it('leaves the text-only path unchanged (no parts → no new errors)', () => {
    const errors = validateLLMRequest(req([{ role: 'user', content: 'just text' }]));
    expect(errors).toEqual([]);
  });

  it('accepts a base64 data: image URL with a detail hint and mixed parts', () => {
    const errors = validateLLMRequest(
      req([
        {
          role: 'user',
          content: 'two angles',
          parts: [
            { type: 'image', url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', detail: 'high' },
            { type: 'image', url: 'https://example.com/2.png' },
            { type: 'text', text: 'the second photo is the shutoff valve' },
          ],
        },
      ]),
    );
    expect(errors).toEqual([]);
  });

  it('rejects image parts on non-user roles', () => {
    const errors = validateLLMRequest(
      req([{ role: 'system', content: 'sys', parts: [{ type: 'image', url: 'https://x/y.jpg' }] }]),
    );
    expect(errors.some((e) => e.includes('only allowed on user messages'))).toBe(true);
  });

  it('rejects an empty or non-image url', () => {
    const empty = validateLLMRequest(
      req([{ role: 'user', content: 'c', parts: [{ type: 'image', url: '' }] }]),
    );
    expect(empty.some((e) => e.includes('image url must be'))).toBe(true);

    const ftp = validateLLMRequest(
      req([{ role: 'user', content: 'c', parts: [{ type: 'image', url: 'ftp://x/y.jpg' }] }]),
    );
    expect(ftp.some((e) => e.includes('image url must be'))).toBe(true);
  });

  it('rejects an empty parts array', () => {
    const errors = validateLLMRequest(req([{ role: 'user', content: 'c', parts: [] }]));
    expect(errors.some((e) => e.includes('non-empty array'))).toBe(true);
  });

  it('rejects a text part with empty text', () => {
    const errors = validateLLMRequest(
      req([{ role: 'user', content: 'c', parts: [{ type: 'text', text: '' }] }]),
    );
    expect(errors.some((e) => e.includes('non-empty text'))).toBe(true);
  });

  it('rejects an unknown content part type', () => {
    const errors = validateLLMRequest(
      req([
        {
          role: 'user',
          content: 'c',
          // @ts-expect-error — deliberately invalid runtime input
          parts: [{ type: 'audio', url: 'https://x/y.mp3' }],
        },
      ]),
    );
    expect(errors.some((e) => e.includes('unknown content part type'))).toBe(true);
  });

  it('accepts a data: URL that carries params before ;base64', () => {
    const errors = validateLLMRequest(
      req([
        {
          role: 'user',
          content: 'c',
          parts: [{ type: 'image', url: 'data:image/png;name=photo.png;base64,iVBORw0KGgo=' }],
        },
      ]),
    );
    expect(errors).toEqual([]);
  });

  it('returns validation errors (never throws) on malformed parts', () => {
    const nonArray = validateLLMRequest(req([badMsg({})]));
    expect(nonArray.some((e) => e.includes('non-empty array'))).toBe(true);

    const nullElement = validateLLMRequest(req([badMsg([null])]));
    expect(nullElement.some((e) => e.includes('must be a content part object'))).toBe(true);
  });
});

describe('messagesContainImage — robustness', () => {
  it('is false (never throws) for malformed or absent parts', () => {
    expect(messagesContainImage([badMsg({})])).toBe(false);
    expect(messagesContainImage([badMsg([null])])).toBe(false);
    expect(messagesContainImage([{ role: 'user', content: 'x' }])).toBe(false);
  });

  it('is true when an image part is present', () => {
    expect(
      messagesContainImage([
        { role: 'user', content: 'x', parts: [{ type: 'image', url: 'https://x/y.jpg' }] },
      ]),
    ).toBe(true);
  });
});
