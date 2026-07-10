import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { EventEmitter } from 'node:events';
import {
  escalationEventsRouter,
  type EscalationEventsDeps,
} from '../../src/escalations/events-route';
import { escalationOutcomeRouter } from '../../src/escalations/outcome-route';
import type { VoiceSessionEvent } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { PanelData } from '../../src/ai/agents/customer-calling/escalation-summary-builder';
import type { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';

const USER_A = 'user_dispatcher_a';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const USER_B = 'user_dispatcher_b';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function makePanel(): PanelData {
  return {
    header: { title: 'Escalated call', callerName: 'Pat', callerPhone: '+15550100' },
    customer: { name: 'Pat', phone: '+15550100', tags: [] },
    lastInteraction: null,
    intent: { summary: 'wants a quote', entities: [] },
    reason: { code: 'caller_requested_human', humanReadable: 'Caller asked for a person' },
    transcriptSnapshot: [],
  } as unknown as PanelData;
}

function escalationStarted(overrides: {
  dispatcherUserId: string;
  tenantId: string;
}): VoiceSessionEvent {
  return {
    type: 'escalation_started',
    escalationId: 'esc_1',
    reason: 'caller_requested_human',
    dispatcherUserId: overrides.dispatcherUserId,
    tenantId: overrides.tenantId,
    panel: makePanel(),
    ts: 1_700_000_000_000,
  } as VoiceSessionEvent;
}

/**
 * The SSE handler never ends its response, so supertest can't drive it.
 * Instead we invoke the router directly with a mock req/res pair and
 * inspect what gets written to the stream.
 */
function makeSseHarness(deps: Partial<EscalationEventsDeps> = {}) {
  let subscriber: ((evt: VoiceSessionEvent) => void) | null = null;
  const unsubscribe = vi.fn();
  const fullDeps: EscalationEventsDeps = {
    authUserIdFromRequest: async () => USER_A,
    authTenantIdFromRequest: async () => TENANT_A,
    subscribeToVoiceEvents: (cb) => {
      subscriber = cb;
      return unsubscribe;
    },
    ...deps,
  };
  const router = escalationEventsRouter(fullDeps);

  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = 'GET';
  req.url = '/events';
  req.headers = {};

  const chunks: string[] = [];
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    set(field: string, value: string) {
      this.headers[field] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn(),
  };

  const run = async () => {
    (router as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void)(
      req,
      res,
      () => {},
    );
    // The route handler is async (awaits the auth lookups); let it settle.
    await new Promise((resolve) => setImmediate(resolve));
  };

  return {
    run,
    req,
    res,
    chunks,
    unsubscribe,
    emit: (evt: VoiceSessionEvent) => subscriber?.(evt),
    hasSubscriber: () => subscriber !== null,
  };
}

describe('escalationEventsRouter (SSE)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams escalation_started events addressed to the authenticated dispatcher', async () => {
    const h = makeSseHarness();
    await h.run();

    expect(h.res.headers['Content-Type']).toBe('text/event-stream');
    expect(h.res.flushHeaders).toHaveBeenCalled();

    const evt = escalationStarted({ dispatcherUserId: USER_A, tenantId: TENANT_A });
    h.emit(evt);

    const dataFrames = h.chunks.filter((c) => c.startsWith('data: '));
    expect(dataFrames).toHaveLength(1);
    expect(JSON.parse(dataFrames[0].slice('data: '.length))).toMatchObject({
      type: 'escalation_started',
      escalationId: 'esc_1',
      dispatcherUserId: USER_A,
      tenantId: TENANT_A,
    });
  });

  it('never forwards another tenant\'s events, even for the same dispatcher userId', async () => {
    const h = makeSseHarness();
    await h.run();

    h.emit(escalationStarted({ dispatcherUserId: USER_A, tenantId: TENANT_B }));

    expect(h.chunks.filter((c) => c.startsWith('data: '))).toHaveLength(0);
  });

  it('never forwards events addressed to a different dispatcher in the same tenant', async () => {
    const h = makeSseHarness();
    await h.run();

    h.emit(escalationStarted({ dispatcherUserId: USER_B, tenantId: TENANT_A }));

    expect(h.chunks.filter((c) => c.startsWith('data: '))).toHaveLength(0);
  });

  it('ignores non-escalation voice events', async () => {
    const h = makeSseHarness();
    await h.run();

    h.emit({ type: 'ended', reason: 'hangup' });
    h.emit({ type: 'proposal_created', proposalId: 'p1' });

    expect(h.chunks.filter((c) => c.startsWith('data: '))).toHaveLength(0);
  });

  it('returns 401 without subscribing when the user is unauthenticated', async () => {
    const h = makeSseHarness({ authUserIdFromRequest: async () => null });
    await h.run();

    expect(h.res.statusCode).toBe(401);
    expect(h.res.end).toHaveBeenCalled();
    expect(h.hasSubscriber()).toBe(false);
  });

  it('returns 401 without subscribing when the tenant cannot be resolved', async () => {
    const h = makeSseHarness({ authTenantIdFromRequest: async () => null });
    await h.run();

    expect(h.res.statusCode).toBe(401);
    expect(h.hasSubscriber()).toBe(false);
  });

  it('returns 500 when the auth lookup rejects instead of leaving the request hanging', async () => {
    const h = makeSseHarness({
      authUserIdFromRequest: async () => {
        throw new Error('clerk unavailable');
      },
    });
    await h.run();

    expect(h.res.statusCode).toBe(500);
    expect(h.res.end).toHaveBeenCalled();
    expect(h.hasSubscriber()).toBe(false);
  });

  it('swallows writes to a dead socket instead of letting them escape the emitter', async () => {
    const h = makeSseHarness();
    await h.run();
    h.res.write.mockImplementation(() => {
      throw new Error('EPIPE');
    });

    expect(() =>
      h.emit(escalationStarted({ dispatcherUserId: USER_A, tenantId: TENANT_A })),
    ).not.toThrow();
  });

  it('sends heartbeats while open and stops them (and unsubscribes) on close', async () => {
    // Fake only intervals — run() settles via a real setImmediate.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = makeSseHarness();
    await h.run();

    vi.advanceTimersByTime(25_000);
    expect(h.chunks.filter((c) => c === ': hb\n\n')).toHaveLength(1);

    h.req.emit('close');
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.res.end).toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(h.chunks.filter((c) => c === ': hb\n\n')).toHaveLength(1);
  });
});

describe('escalationOutcomeRouter', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(
      '/api/escalations',
      escalationOutcomeRouter({ store: {} as VoiceSessionStore }),
    );
  });

  it.each(['resolved', 'hung_up', 'needs_callback'])(
    'acknowledges a %s outcome with 200',
    async (outcome) => {
      const res = await request(app)
        .post('/api/escalations/esc_1/outcome')
        .send({ outcome });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    },
  );

  it('rejects an unknown outcome value with 400', async () => {
    const res = await request(app)
      .post('/api/escalations/esc_1/outcome')
      .send({ outcome: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_outcome' });
  });

  it('rejects a body without an outcome field with 400', async () => {
    const res = await request(app).post('/api/escalations/esc_1/outcome').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_outcome' });
  });
});
