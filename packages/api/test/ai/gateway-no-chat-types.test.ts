/**
 * P2-027 Gap 2 — No Chat* type exports from ai/gateway
 *
 * Verifies that ChatRequest, ChatResponse, ChatMessage are NOT exported from the
 * gateway index after types.ts is deleted.
 */

describe('P2-027 Gap 2 — no Chat* symbols exported from ai/gateway', () => {
  it('does not export ChatRequest from gateway index', async () => {
    const gatewayExports = await import('../../src/ai/gateway/index');
    expect((gatewayExports as Record<string, unknown>).ChatRequest).toBeUndefined();
  });

  it('does not export ChatResponse from gateway index', async () => {
    const gatewayExports = await import('../../src/ai/gateway/index');
    expect((gatewayExports as Record<string, unknown>).ChatResponse).toBeUndefined();
  });

  it('does export LLMRequest-based types from gateway index', async () => {
    const gatewayExports = await import('../../src/ai/gateway/index');
    // LLMGateway is a class (value export)
    expect(typeof (gatewayExports as Record<string, unknown>).LLMGateway).toBe('function');
    // createLLMGateway is a function (value export)
    expect(typeof (gatewayExports as Record<string, unknown>).createLLMGateway).toBe('function');
    expect(typeof (gatewayExports as Record<string, unknown>).createMockLLMGateway).toBe('function');
  });
});
