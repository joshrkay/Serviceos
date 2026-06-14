/**
 * F-A U2 — adapter message translation (pure, no network).
 *
 * buildChatMessages() must keep the text path byte-identical and map our
 * provider-neutral `image` parts to the OpenAI `image_url` content shape.
 */
import { describe, it, expect } from 'vitest';
import { buildChatMessages } from '../../../src/ai/providers/openai-compatible';
import type { LLMMessage } from '../../../src/ai/gateway/gateway';

describe('buildChatMessages — multimodal translation', () => {
  it('passes text-only messages through as plain string content', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'you are an estimator' },
      { role: 'user', content: 'two hours labor' },
    ];
    expect(buildChatMessages(messages)).toEqual([
      { role: 'system', content: 'you are an estimator' },
      { role: 'user', content: 'two hours labor' },
    ]);
  });

  it('builds an ordered content-part array: leading text, then parts in order', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: 'what work is needed?',
        parts: [
          { type: 'image', url: 'https://example.com/a.jpg', detail: 'high' },
          { type: 'text', text: 'second angle below' },
          { type: 'image', url: 'https://example.com/b.jpg' },
        ],
      },
    ];
    expect(buildChatMessages(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what work is needed?' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.jpg', detail: 'high' } },
          { type: 'text', text: 'second angle below' },
          { type: 'image_url', image_url: { url: 'https://example.com/b.jpg' } },
        ],
      },
    ]);
  });

  it('omits the leading text part when message content is empty', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: '',
        parts: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' }],
      },
    ];
    expect(buildChatMessages(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      },
    ]);
  });
});
