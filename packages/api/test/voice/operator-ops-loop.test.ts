/**
 * Operator money/CRM top-40 closed loop.
 *
 * The inbound voice-quality corpus (~68 scripts) proves receptionist /
 * booking quality. It does NOT cover the operator money loop Mike lives in:
 * create/edit client, job, estimate, invoice + send. Those ten ops are
 * speakable end-to-end in code (see docs/reference/voice-action-catalog.md)
 * but previously had only sparse golden-path + router unit coverage — so the
 * same doomed-approval / missingFields / action-class regressions could keep
 * coming back.
 *
 * This suite is the closed loop for that gap:
 *   fixture JSON (40 utterances) → scripted LLM gateway → real
 *   voice-action-router → assert proposal type, status, action class,
 *   and missingFields gates.
 *
 * If this suite is red, the operator voice money loop is not shippable.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import {
  InMemoryProposalRepository,
  actionClassForProposalType,
  missingFieldsFor,
  type ProposalType,
  type ActionClass,
} from '../../src/proposals/proposal';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, 'fixtures/operator-ops-top-40.json');

const TENANT = 't-ops-loop';
const USER = 'u-ops-loop';

interface CaseExpect {
  proposalType: ProposalType;
  status?: string;
  actionClass?: ActionClass;
  missingFieldsContains?: string[];
  missingFieldsExact?: string[];
  payloadContains?: Record<string, unknown>;
  proposalCount?: number;
}

interface OpsCase {
  id: string;
  op: string;
  utterance: string;
  llmResponses: unknown[];
  expect: CaseExpect;
}

interface OpsCorpus {
  version: number;
  ops: string[];
  cases: OpsCase[];
}

function loadCorpus(): OpsCorpus {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as OpsCorpus;
}

function silentLogger(): Logger {
  const noop = (..._args: unknown[]) => {};
  const base = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => base,
  } as unknown as Logger;
  return base;
}

function scriptedGateway(responses: unknown[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify(responses[Math.min(i++, responses.length - 1)]),
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function msg<T>(payload: T): QueueMessage<T> {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
  };
}

const corpus = loadCorpus();

describe('Operator money/CRM top-40 closed loop', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
  });

  it('corpus covers all ten ops with exactly forty cases (4 each)', () => {
    expect(corpus.cases).toHaveLength(40);
    expect(corpus.ops).toHaveLength(10);
    const counts = new Map<string, number>();
    for (const c of corpus.cases) {
      counts.set(c.op, (counts.get(c.op) ?? 0) + 1);
    }
    for (const op of corpus.ops) {
      expect(counts.get(op), `op ${op} must have 4 cases`).toBe(4);
    }
    const ids = corpus.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const c of corpus.cases) {
    it(`${c.id}: "${c.utterance}" → ${c.expect.proposalType}`, async () => {
      const gateway = scriptedGateway(c.llmResponses);
      const worker = createVoiceActionRouterWorker({ gateway, proposalRepo });

      await worker.handle(
        msg({
          tenantId: TENANT,
          userId: USER,
          transcript: c.utterance,
        }),
        silentLogger(),
      );

      const proposals = await proposalRepo.findByTenant(TENANT);
      const expectedCount = c.expect.proposalCount ?? 1;
      expect(proposals, `${c.id}: proposal count`).toHaveLength(expectedCount);

      if (expectedCount === 0) return;

      const proposal = proposals[0]!;
      expect(proposal.proposalType, `${c.id}: proposalType`).toBe(c.expect.proposalType);

      if (c.expect.status) {
        expect(proposal.status, `${c.id}: status`).toBe(c.expect.status);
      }

      if (c.expect.actionClass) {
        expect(
          actionClassForProposalType(proposal.proposalType),
          `${c.id}: actionClass`,
        ).toBe(c.expect.actionClass);
        // Comms / money / irreversible must never auto-approve.
        if (c.expect.actionClass !== 'capture') {
          expect(proposal.status, `${c.id}: non-capture stays draft`).toBe('draft');
        }
      }

      const missing = missingFieldsFor(proposal);
      if (c.expect.missingFieldsExact) {
        expect(missing, `${c.id}: missingFieldsExact`).toEqual(c.expect.missingFieldsExact);
      }
      if (c.expect.missingFieldsContains) {
        for (const field of c.expect.missingFieldsContains) {
          expect(missing, `${c.id}: missingFieldsContains ${field}`).toContain(field);
        }
      }

      if (c.expect.payloadContains) {
        const payload = proposal.payload as Record<string, unknown>;
        for (const [key, value] of Object.entries(c.expect.payloadContains)) {
          expect(payload[key], `${c.id}: payload.${key}`).toEqual(value);
        }
      }
    });
  }
});
