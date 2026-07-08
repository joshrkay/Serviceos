/**
 * D1 — Contract test: verify that API endpoints called by JobSheets and
 * CancelNoShowSheet actually exist in the API route definitions.
 *
 * This test fails if a web component calls a path that the API doesn't
 * register, preventing phantom endpoint bugs from shipping.
 */
import { describe, it, expect } from 'vitest';

/**
 * Route manifest extracted from packages/api/src/routes/*.ts.
 * Each entry: { method, pathPattern } where pathPattern uses Express :param syntax.
 *
 * Maintained manually — when adding new API routes that the sheets call,
 * add the route here. Failure to do so will break this test and alert
 * the developer that the route is not registered.
 */
const API_ROUTE_MANIFEST: Array<{ method: string; pathPattern: string }> = [
  // conversations.ts — Story 3.11 search
  { method: 'GET', pathPattern: '/api/conversations/search' },
  // conversations.ts — POST / (create conversation)
  { method: 'POST', pathPattern: '/api/conversations' },
  // conversations.ts — POST /customer/:customerId (get-or-create customer thread)
  { method: 'POST', pathPattern: '/api/conversations/customer/:customerId' },
  // conversations.ts — GET /:id
  { method: 'GET', pathPattern: '/api/conversations/:id' },
  // conversations.ts — POST /:id/reply (U6 owner-authored outbound)
  { method: 'POST', pathPattern: '/api/conversations/:id/reply' },
  // appointments.ts — PUT /:id
  { method: 'PUT', pathPattern: '/api/appointments/:id' },
  // appointments.ts — POST /:id/delay-ack
  { method: 'POST', pathPattern: '/api/appointments/:id/delay-ack' },
  // jobs.ts — PUT /:id
  { method: 'PUT', pathPattern: '/api/jobs/:id' },
  // jobs.ts — POST /:id/transition
  { method: 'POST', pathPattern: '/api/jobs/:id/transition' },
  // estimates.ts — GET / (jobId-filtered bare-array lookup)
  { method: 'GET', pathPattern: '/api/estimates' },
  // invoices.ts — GET / (jobId-filtered bare-array lookup)
  { method: 'GET', pathPattern: '/api/invoices' },
];

/**
 * API paths called by JobSheets.tsx and CancelNoShowSheet.tsx (post-D1 fix).
 * Each entry: { method, pathTemplate } where pathTemplate is the literal
 * template string from the source (e.g. `/api/conversations/search?customerId=...`).
 */
const JOB_SHEETS_API_CALLS: Array<{ method: string; pathTemplate: string; source: string }> = [
  // TextSheet (JobSheets.tsx) — search for existing thread
  { method: 'GET', pathTemplate: '/api/conversations/search', source: 'JobSheets.tsx:TextSheet.handleSend' },
  // TextSheet — create new conversation if none exists
  { method: 'POST', pathTemplate: '/api/conversations', source: 'JobSheets.tsx:TextSheet.handleSend' },
  // TextSheet — send reply
  { method: 'POST', pathTemplate: '/api/conversations/:id/reply', source: 'JobSheets.tsx:TextSheet.handleSend' },
  // EstimateSheet — load the job's real estimate(s)
  { method: 'GET', pathTemplate: '/api/estimates?jobId=:jobId', source: 'JobSheets.tsx:EstimateSheet' },
  // InvoiceSheet — load the job's real invoice(s)
  { method: 'GET', pathTemplate: '/api/invoices?jobId=:jobId', source: 'JobSheets.tsx:InvoiceSheet' },
];

const CANCEL_NO_SHOW_SHEET_API_CALLS: Array<{ method: string; pathTemplate: string; source: string }> = [
  // Cancel appointment via PUT
  { method: 'PUT', pathTemplate: '/api/appointments/:id', source: 'CancelNoShowSheet.tsx:handleConfirmedSubmit' },
  // Cancel job via transition endpoint
  { method: 'POST', pathTemplate: '/api/jobs/:id/transition', source: 'CancelNoShowSheet.tsx:handleConfirmedSubmit' },
  // Search for existing thread (text customer)
  { method: 'GET', pathTemplate: '/api/conversations/search', source: 'CancelNoShowSheet.tsx:handleConfirmedSubmit' },
  // Create thread if none exists
  { method: 'POST', pathTemplate: '/api/conversations', source: 'CancelNoShowSheet.tsx:handleConfirmedSubmit' },
  // Send cancellation message
  { method: 'POST', pathTemplate: '/api/conversations/:id/reply', source: 'CancelNoShowSheet.tsx:handleConfirmedSubmit' },
];

/**
 * Normalize a path template to a pattern: strip query strings and match
 * dynamic segments (`:param`) to any non-slash sequence.
 */
function pathToPattern(path: string): string {
  // Remove query string
  const basePath = path.split('?')[0];
  // Replace :param with a regex placeholder
  return basePath.replace(/:[^/]+/g, '[^/]+');
}

/**
 * Check if a path template matches any route in the manifest.
 */
function routeExists(method: string, pathTemplate: string): boolean {
  const pattern = pathToPattern(pathTemplate);
  return API_ROUTE_MANIFEST.some((route) => {
    if (route.method !== method) return false;
    const routePattern = pathToPattern(route.pathPattern);
    // Exact match (after normalization)
    return pattern === routePattern;
  });
}

describe('D1 — Job sheets API route contract', () => {
  describe('JobSheets.tsx API calls', () => {
    for (const call of JOB_SHEETS_API_CALLS) {
      it(`${call.method} ${call.pathTemplate} exists in API (${call.source})`, () => {
        expect(
          routeExists(call.method, call.pathTemplate),
          `Phantom endpoint: ${call.method} ${call.pathTemplate} is not registered in the API. ` +
            `Source: ${call.source}. Add the route to API_ROUTE_MANIFEST if it exists, or fix the call.`,
        ).toBe(true);
      });
    }
  });

  describe('CancelNoShowSheet.tsx API calls', () => {
    for (const call of CANCEL_NO_SHOW_SHEET_API_CALLS) {
      it(`${call.method} ${call.pathTemplate} exists in API (${call.source})`, () => {
        expect(
          routeExists(call.method, call.pathTemplate),
          `Phantom endpoint: ${call.method} ${call.pathTemplate} is not registered in the API. ` +
            `Source: ${call.source}. Add the route to API_ROUTE_MANIFEST if it exists, or fix the call.`,
        ).toBe(true);
      });
    }
  });

  describe('Manifest completeness', () => {
    it('API_ROUTE_MANIFEST contains no duplicate entries', () => {
      const seen = new Set<string>();
      for (const route of API_ROUTE_MANIFEST) {
        const key = `${route.method} ${route.pathPattern}`;
        expect(seen.has(key), `Duplicate manifest entry: ${key}`).toBe(false);
        seen.add(key);
      }
    });
  });
});
