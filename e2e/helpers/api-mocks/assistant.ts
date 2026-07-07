/**
 * Assistant domain mocks — chat + proposal approve/reject.
 *
 * Unlike jobs/estimates/invoices, the assistant chat response and its inline
 * proposal are UI shapes (packages/web/src/data/mock-data.ts `AIProposal`),
 * not @ai-service-os/shared contracts — there's no shared Zod schema to pin
 * them to yet (tracked as deferred follow-up in the plan). So the regression
 * weight sits on the REQUEST assertions the spec makes (the chat body carries
 * the typed message; approve/reject POST the right proposal path), while the
 * response bodies stay minimal-but-valid for the card to render.
 */

import type { Page, Route } from '@playwright/test';
import type { ApiTrackerEntry } from '../offline-app';

export const PROPOSAL_ID = 'prop-e2e-0001';

/** Minimal AIProposal (UI shape) — Pending, no missingFields (Approve stays enabled). */
function buildUiProposal() {
  return {
    id: PROPOSAL_ID,
    title: 'Send estimate EST-2042 to Priya Shah',
    summary: 'Draft is ready — send the secure link by SMS.',
    explanation: 'The estimate is complete and the customer has a phone on file.',
    confidence: 'High',
    type: 'Send',
    status: 'Pending',
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const APPROVE_RE = /^\/api\/proposals\/([^/]+)\/approve$/;
const REJECT_RE = /^\/api\/proposals\/([^/]+)\/reject$/;

export async function installAssistantMocks(
  page: Page,
  tracker: ApiTrackerEntry[],
  opts: { withProposal?: boolean } = {},
): Promise<void> {
  const withProposal = opts.withProposal ?? true;

  await page.route(
    (url) => url.pathname === '/api/assistant/chat',
    async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const body = req.postDataJSON() as { messages?: Array<{ role: string; content: string }> };
      tracker.push({ method: 'POST', path: '/api/assistant/chat', body });
      await json(route, {
        conversationId: 'conv-e2e-1',
        message: {
          content: 'On it — here\'s what I can do.',
          ...(withProposal ? { proposal: buildUiProposal() } : {}),
        },
      });
    },
  );

  await page.route(
    (url) => APPROVE_RE.test(url.pathname),
    async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const path = new URL(req.url()).pathname;
      tracker.push({ method: 'POST', path });
      await json(route, { ok: true, id: path.match(APPROVE_RE)![1] });
    },
  );

  await page.route(
    (url) => REJECT_RE.test(url.pathname),
    async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const path = new URL(req.url()).pathname;
      tracker.push({ method: 'POST', path });
      await json(route, { ok: true, id: path.match(REJECT_RE)![1] });
    },
  );
}
