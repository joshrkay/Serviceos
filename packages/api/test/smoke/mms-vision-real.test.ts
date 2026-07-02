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
 *
 * `mms_estimate` routes to the COMPLEX tier (default `claude-sonnet-4-6`); set
 * `AI_COMPLEX_MODEL` to a vision-capable model matching your provider (the
 * workflow pins `gpt-4o` for the default OpenAI-compatible endpoint) so the
 * gateway doesn't send a Claude model name to OpenAI.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../../src/shared/config';
import { createLLMGateway } from '../../src/ai/gateway/factory';
import { MmsEstimateTaskHandler } from '../../src/ai/tasks/mms-estimate-task';

const MMS_VISION_SMOKE = process.env.MMS_VISION_SMOKE === '1';
const HAS_API_KEY = !!process.env.AI_PROVIDER_API_KEY;
const IMAGE_PATH = process.env.MMS_VISION_SMOKE_IMAGE ?? 'test/fixtures/mms-smoke.jpg';
const HAS_IMAGE = existsSync(IMAGE_PATH);

// Fail-hard: when MMS_VISION_SMOKE=1 (the workflow sets this), missing API key
// or fixture is a FAILURE, not a skip. Skipped tests do not constitute a green
// gate — the workflow must fail loudly when misconfigured.
if (MMS_VISION_SMOKE && !HAS_API_KEY) {
  throw new Error(
    '[mms-vision-smoke] FATAL: MMS_VISION_SMOKE=1 but AI_PROVIDER_API_KEY is empty. ' +
      'This workflow cannot pass without a real API key.',
  );
}
if (MMS_VISION_SMOKE && !HAS_IMAGE) {
  throw new Error(
    `[mms-vision-smoke] FATAL: MMS_VISION_SMOKE=1 but no fixture at ${IMAGE_PATH}. ` +
      'Commit a real repair photo or set MMS_VISION_SMOKE_IMAGE.',
  );
}

const ENABLED = MMS_VISION_SMOKE && HAS_API_KEY;

function imageDataUri(): string {
  const bytes = readFileSync(IMAGE_PATH);
  const ext = IMAGE_PATH.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  return `data:image/${ext};base64,${bytes.toString('base64')}`;
}

describe.skipIf(!ENABLED || !HAS_IMAGE)('U4 — MMS vision real smoke', () => {
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
