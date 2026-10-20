/**
 * U7 (S6-3) — the public demo-call routes, mounted at `/public/demo` so the
 * `/public` per-IP limiter (app.ts) applies. This story adds the start half:
 *
 *   POST /public/demo/calls  { phone, trade, businessName, metro? }
 *
 * The callbacks (voice, gather, status) are S6-6's. Copy is shown to the
 * visitor as is, so it is plain words.
 */
import express, { Router } from 'express';
import { DemoCallStartInputSchema, type DemoCallError, type DemoCallStartResponse } from '@ai-service-os/shared';
import { DEMO_BUSY_MESSAGE } from './script';
import { demoCallGate, startDemoCall, type DemoCallServiceDeps, type StartDemoCallResult } from './service';

const COPY = {
  INVALID_INPUT: 'Check the number and business name, then try again.',
  DEMO_NUMBER_NOT_ALLOWED: 'We can only call a US or Canadian phone number.',
  DEMO_DAILY_LIMIT: "You've already had today's demo. Try again tomorrow.",
  DEMO_BUSY: DEMO_BUSY_MESSAGE,
  DEMO_DISABLED: "The demo call isn't available right now.",
  DEMO_CALL_FAILED: "We couldn't place the call. Please try again in a few minutes.",
} as const;

const err = (error: DemoCallError['error']): DemoCallError => ({ error, message: COPY[error] });

/** The status code and body each start outcome answers. */
export function demoStartHttp(result: StartDemoCallResult): { status: number; body: DemoCallError | DemoCallStartResponse } {
  switch (result.kind) {
    case 'disabled':
      return { status: 503, body: err('DEMO_DISABLED') };
    case 'number_not_allowed':
      return { status: 400, body: err('DEMO_NUMBER_NOT_ALLOWED') };
    case 'rate_limited':
      return { status: 429, body: err('DEMO_DAILY_LIMIT') };
    case 'busy':
      return { status: 503, body: err('DEMO_BUSY') };
    case 'failed':
      return { status: 502, body: err('DEMO_CALL_FAILED') };
    case 'calling':
      // An unconfirmed call may be ringing: the visitor is answered as for a success.
      return { status: 202, body: { correlationId: result.correlationId, status: 'calling' } };
  }
}

export function createDemoCallsRouter(deps: DemoCallServiceDeps): Router {
  const router = Router();
  router.post('/calls', express.json({ limit: '4kb' }), async (req, res, next) => {
    try {
      // The kill switch and a closed module answer before the body is read.
      const gate = demoCallGate(deps);
      if (gate.kind === 'disabled') {
        const out = demoStartHttp(gate);
        res.status(out.status).json(out.body);
        return;
      }
      const parsed = DemoCallStartInputSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(err('INVALID_INPUT'));
        return;
      }
      const out = demoStartHttp(await startDemoCall(parsed.data, deps));
      res.status(out.status).json(out.body);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
