/**
 * #1737 — public, unauthenticated web chat endpoints (mounted before the global
 * /api auth, like public booking and intake). Tenant is identified by the embed
 * token in the body, never by a path segment.
 *
 *   GET  /widget.js   the embeddable script (static, tenant-agnostic)
 *   POST /session     start a chat
 *   POST /message     one visitor turn
 *   POST /handoff     leave contact details / ask for the owner
 *   POST /end         the visitor closed the chat
 *
 * The widget is served from the API origin but runs on the tenant's own site,
 * so these are cross-origin. Requests are `text/plain` JSON ("simple" CORS
 * requests, no preflight); the service's per-tenant allowed-origin check is
 * the authorization, and the response echoes the request Origin so the
 * browser lets the widget read it. No cookies or credentials are involved.
 */
import express, { Request, Response, Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/async-route';
import { WIDGET_SCRIPT } from '../webchat/widget-script';
import { WebchatError, type WebchatService } from '../webchat/webchat-service';

const base = z.object({ token: z.string().max(100) });
const sessionBody = base.extend({ botToken: z.string().max(4096).optional() });
const messageBody = base.extend({ sessionId: z.string().uuid(), text: z.string().max(2000) });
const handoffBody = base.extend({
  sessionId: z.string().uuid(),
  name: z.string().trim().max(100).default(''),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  note: z.string().trim().max(1000).optional(),
  requestOwner: z.boolean().default(false),
});
const endBody = base.extend({ sessionId: z.string().uuid() });

export function createPublicWebchatRouter(deps: { service: WebchatService }): Router {
  const router = Router();
  const { service } = deps;

  // Browsers block a cross-origin <script> when Helmet's default
  // Cross-Origin-Resource-Policy is same-origin; this router is the exception.
  router.use((req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    const origin = req.get('origin');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.removeHeader('Access-Control-Allow-Credentials');
      res.vary('Origin');
    }
    next();
  });

  router.get('/widget.js', (_req: Request, res: Response) => {
    res.type('application/javascript').set('Cache-Control', 'public, max-age=300').send(WIDGET_SCRIPT);
  });

  // text/plain bodies carry JSON (see header); application/json is parsed upstream.
  router.use(express.text({ type: 'text/plain', limit: '8kb' }));

  function body(req: Request): unknown {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        throw new WebchatError('VALIDATION_ERROR', 'Invalid request body');
      }
    }
    return req.body ?? {};
  }
  const origin = (req: Request) => req.get('origin') ?? undefined;

  function fail(res: Response, err: unknown): void {
    if (err instanceof WebchatError) {
      res.status(err.status).json({ error: err.code, message: err.message });
    } else if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid request' });
    } else {
      throw err;
    }
  }

  router.post('/session', asyncRoute(async (req, res) => {
    try {
      const b = sessionBody.parse(body(req));
      res.status(201).json(
        await service.startSession({ token: b.token, origin: origin(req), ip: req.ip, botToken: b.botToken }),
      );
    } catch (err) {
      fail(res, err);
    }
  }));

  router.post('/message', asyncRoute(async (req, res) => {
    try {
      const b = messageBody.parse(body(req));
      res.status(200).json(
        await service.sendMessage({
          token: b.token,
          origin: origin(req),
          ip: req.ip,
          sessionId: b.sessionId,
          text: b.text,
        }),
      );
    } catch (err) {
      fail(res, err);
    }
  }));

  router.post('/handoff', asyncRoute(async (req, res) => {
    try {
      const b = handoffBody.parse(body(req));
      const result = await service.handoff({
        token: b.token,
        origin: origin(req),
        ip: req.ip,
        sessionId: b.sessionId,
        name: b.name,
        ...(b.phone ? { phone: b.phone } : {}),
        ...(b.email ? { email: b.email } : {}),
        ...(b.note ? { note: b.note } : {}),
        requestOwner: b.requestOwner,
      });
      res.status(201).json({ ok: true, bookingUrl: result.bookingUrl });
    } catch (err) {
      fail(res, err);
    }
  }));

  router.post('/end', asyncRoute(async (req, res) => {
    try {
      const b = endBody.parse(body(req));
      await service.endSession({ token: b.token, origin: origin(req), sessionId: b.sessionId });
      res.status(200).json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  }));

  return router;
}
