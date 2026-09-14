/**
 * #1173 — EstimateTaskHandler accepts operator-attached photos as image parts.
 *
 * The chat draft path used to build a text-only model request, so a photo that
 * reached the Assistant turn (#1144) could never inform the draft. With
 * `context.images`, the user message carries one image part per photo (the
 * MmsEstimateTaskHandler `LLMContentPart` shape) plus a delimited photo
 * guidance section; without it the request is unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { EstimateTaskHandler } from '../../../src/ai/tasks/estimate-task';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { TaskContext } from '../../../src/ai/tasks/task-handlers';

const DRAFT = JSON.stringify({
  lineItems: [{ description: 'Replace P-trap under sink', quantity: 1, unitPrice: 18500 }],
  notes: 'Visible corrosion on the trap',
  confidence_score: 0.8,
});

function recordingGateway(): { gateway: LLMGateway; calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  const gateway = {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
      calls.push(req);
      return { content: DRAFT, model: 'm', provider: 'p', latencyMs: 1 } as LLMResponse;
    }),
  } as unknown as LLMGateway;
  return { gateway, calls };
}

function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 'tenant-1173',
    userId: 'user-1173',
    message: "Here's the photo — can you identify the issue?",
    customerId: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
  };
}

describe('#1173 — EstimateTaskHandler image input', () => {
  it('sends one image part per attached photo on the user message, plus the photo guidance section', async () => {
    const { gateway, calls } = recordingGateway();
    const handler = new EstimateTaskHandler(gateway);

    const { proposal } = await handler.handle(
      ctx({
        images: [
          { url: 'https://storage.test/t/a.jpg?sig=1', contentType: 'image/jpeg', fileId: 'file-a' },
          { url: 'https://storage.test/t/b.png?sig=2', contentType: 'image/png', fileId: 'file-b' },
        ],
      }),
    );

    expect(calls).toHaveLength(1);
    const user = calls[0]!.messages.find((m) => m.role === 'user')!;
    expect(user.parts).toEqual([
      { type: 'image', url: 'https://storage.test/t/a.jpg?sig=1' },
      { type: 'image', url: 'https://storage.test/t/b.png?sig=2' },
    ]);
    // The text block is still the request (the model never sees the fileIds).
    expect(user.content).toContain('<user_request>');
    expect(JSON.stringify(calls[0]!.messages)).not.toContain('file-a');
    expect(
      calls[0]!.messages.some((m) => m.role === 'system' && m.content.includes('PHOTOS of the work')),
    ).toBe(true);

    expect(proposal.proposalType).toBe('draft_estimate');
    expect(proposal.sourceContext?.photoFileIds).toEqual(['file-a', 'file-b']);
    expect(proposal.confidenceFactors).toContain('chat_photo_source');
  });

  it('with no images the request carries no parts and no photo section (text-only path unchanged)', async () => {
    const { gateway, calls } = recordingGateway();
    const handler = new EstimateTaskHandler(gateway);

    const { proposal } = await handler.handle(ctx({ message: 'Estimate a P-trap replacement' }));

    const user = calls[0]!.messages.find((m) => m.role === 'user')!;
    expect(user).not.toHaveProperty('parts');
    expect(calls[0]!.messages.some((m) => m.content.includes('PHOTOS of the work'))).toBe(false);
    expect(proposal.sourceContext?.photoFileIds).toBeUndefined();
    expect(proposal.confidenceFactors).not.toContain('chat_photo_source');
  });
});
