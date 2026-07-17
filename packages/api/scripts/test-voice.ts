/**
 * Local voice-to-action harness.
 *
 * Boots the voice-action-router worker chain in-process with in-memory
 * repositories, feeds it a transcript (from CLI arg or stdin), and
 * prints whatever proposal lands — or "unknown" if the classifier
 * drops the transcript.
 *
 * Use one of:
 *
 *   # Mock LLM — fastest, needs no credentials. Useful for wiring
 *   # tests but the classifier will always say "unknown" because
 *   # the mock returns a canned response. Set MOCK_RESPONSES to
 *   # override with scripted intent/task JSON (see examples below).
 *   npx ts-node scripts/test-voice.ts "create an invoice for Acme for 450 dollars"
 *
 *   # Real OpenAI — classifier runs for real.
 *   AI_PROVIDER_API_KEY=sk-... \
 *     npx ts-node scripts/test-voice.ts "create an invoice for Acme for 450 dollars"
 *
 *   # Scripted LLM responses — simulate the full chain without hitting
 *   # an external API. Each call to the gateway pops the next response.
 *   MOCK_RESPONSES='[
 *     {"intentType":"create_invoice","confidence":0.92,"extractedEntities":{"customerName":"Acme"}},
 *     {"customerId":"c-1","jobId":"j-1","lineItems":[{"description":"repair","quantity":1,"unitPrice":45000}],"confidence_score":0.92}
 *   ]' npx ts-node scripts/test-voice.ts "create an invoice for Acme for 450"
 *
 * The script exits 0 on a proposal, 1 on unknown/error.
 */
import { InMemoryProposalRepository } from '../src/proposals/proposal';
import {
  createVoiceActionRouterWorker,
  VoiceActionRouterPayload,
} from '../src/workers/voice-action-router';
import { createLLMGateway, createHermeticMockLLMGateway } from '../src/ai/gateway/factory';
import { loadConfig } from '../src/shared/config';
import type { LLMGateway, LLMResponse } from '../src/ai/gateway/gateway';
import type { QueueMessage } from '../src/queues/queue';

interface TestLogger {
  debug: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  child: () => TestLogger;
}

function buildLogger(): TestLogger {
  const logger: TestLogger = {
    debug: (...a) => console.log('[debug]', ...a),
    info: (...a) => console.log('[info]', ...a),
    warn: (...a) => console.warn('[warn]', ...a),
    error: (...a) => console.error('[error]', ...a),
    child: () => logger,
  };
  return logger;
}

function buildMessage(payload: VoiceActionRouterPayload): QueueMessage<VoiceActionRouterPayload> {
  return {
    id: 'cli-msg',
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'cli',
    createdAt: new Date().toISOString(),
  };
}

function buildScriptedGateway(responses: string[]): LLMGateway {
  let i = 0;
  return {
    async complete(): Promise<LLMResponse> {
      const content = responses[Math.min(i++, responses.length - 1)];
      return {
        content,
        model: 'scripted',
        provider: 'scripted',
        tokenUsage: { input: 0, output: 0, total: 0 },
        latencyMs: 0,
      };
    },
  } as unknown as LLMGateway;
}

async function main() {
  const transcript = process.argv.slice(2).join(' ').trim();
  if (!transcript) {
    console.error('Usage: test-voice.ts <transcript>');
    console.error('Example: test-voice.ts "create an invoice for Acme for 450 dollars"');
    process.exit(2);
  }

  let gateway: LLMGateway;
  if (process.env.MOCK_RESPONSES) {
    const parsed = JSON.parse(process.env.MOCK_RESPONSES) as unknown[];
    gateway = buildScriptedGateway(parsed.map((p) => JSON.stringify(p)));
    console.log('→ Using scripted LLM responses (%d available)', parsed.length);
  } else if (process.env.AI_PROVIDER_API_KEY) {
    const config = loadConfig();
    gateway = createLLMGateway(config);
    console.log('→ Using real LLM gateway (%s)', config.AI_DEFAULT_MODEL);
  } else {
    gateway = createHermeticMockLLMGateway().gateway;
    console.log('→ Using hermetic mock LLM (scripts create_customer / estimate / invoice).');
    console.log('  Set AI_PROVIDER_API_KEY or MOCK_RESPONSES for custom replies.');
  }

  const proposalRepo = new InMemoryProposalRepository();
  const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

  const payload: VoiceActionRouterPayload = {
    tenantId: 'cli-tenant',
    userId: 'cli-user',
    transcript,
  };

  console.log('\nTranscript:', JSON.stringify(transcript));
  console.log('---');

  await worker.handle(buildMessage(payload), buildLogger());

  const proposals = await proposalRepo.findByTenant('cli-tenant');
  console.log('---');
  if (proposals.length === 0) {
    console.log('NO PROPOSAL CREATED — transcript classified as unknown or dropped.');
    process.exit(1);
  }

  const p = proposals[0];
  console.log('PROPOSAL CREATED:');
  console.log(
    JSON.stringify(
      {
        id: p.id,
        proposalType: p.proposalType,
        status: p.status,
        summary: p.summary,
        confidenceScore: p.confidenceScore,
        payload: p.payload,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('CLI error:', err);
  process.exit(1);
});
