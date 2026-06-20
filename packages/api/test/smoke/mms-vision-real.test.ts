/**
 * U4 — MMS vision REAL smoke (gated; NOT in the default test lane).
 *
 * The mocked unit/integration tests prove orchestration but stub the gateway,
 * so the real image → vision-model → JSON path is unproven (CLAUDE.md: a
 * mocked test is never the only proof). This sends a real repair photo through
 * the production gateway + a vision-capable model and asserts a structured,
 * catalog-groundable draft comes back.
 *
 * Runs ONLY when `MMS_VISION_SMOKE=1` and `AI_PROVIDER_API_KEY` are set (the
 * `mms-vision-smoke` workflow). It needs a REAL repair photo at
 * `MMS_VISION_SMOKE_IMAGE` (default `test/fixtures/mms-smoke.jpg`) — a tiny
 * synthetic image yields no line items and would (correctly) fail the assert.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../../src/shared/config';
import { createLLMGateway } from '../../src/ai/gateway/factory';
import { MmsEstimateTaskHandler } from '../../src/ai/tasks/mms-estimate-task';

const ENABLED = process.env.MMS_VISION_SMOKE === '1' && !!process.env.AI_PROVIDER_API_KEY;
const IMAGE_PATH = process.env.MMS_VISION_SMOKE_IMAGE ?? 'test/fixtures/mms-smoke.jpg';

function imageDataUri(): string {
  if (!existsSync(IMAGE_PATH)) {
    throw new Error(
      `MMS vision smoke needs a real repair photo at ${IMAGE_PATH} ` +
        `(or set MMS_VISION_SMOKE_IMAGE). Commit a jpg/png of an actual repair.`,
    );
  }
  const bytes = readFileSync(IMAGE_PATH);
  const ext = IMAGE_PATH.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  return `data:image/${ext};base64,${bytes.toString('base64')}`;
}

describe.skipIf(!ENABLED)('U4 — MMS vision real smoke', () => {
  it('drafts ≥1 line item from a real photo through the real vision model', async () => {
    const gateway = createLLMGateway(loadConfig());
    const handler = new MmsEstimateTaskHandler(gateway);

    const result = await handler.handle({
      tenantId: '00000000-0000-0000-0000-000000000000',
      customerId: '00000000-0000-0000-0000-000000000001',
      images: [{ url: imageDataUri(), contentType: 'image/jpeg' }],
      createdBy: 'smoke:mms-vision',
      message: 'Can you quote this repair?',
    });

    // The whole point: a REAL vision call returned a parseable, catalog-
    // groundable estimate — not a mock.
    expect(result.status).toBe('drafted');
    if (result.status !== 'drafted') return;
    const lineItems = result.proposal.payload.lineItems as unknown[];
    expect(lineItems.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
