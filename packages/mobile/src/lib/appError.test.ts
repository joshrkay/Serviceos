import { describe, expect, it } from 'vitest';
import { decodeError, type AppError } from './appError';
import { makeTimeoutError, makeUnauthenticatedAbort } from './apiFetch';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('decodeError', () => {
  it('maps a 404 NOT_FOUND body to kind notFound and surfaces the server message', async () => {
    const res = jsonResponse(404, { error: 'NOT_FOUND', message: 'Customer not found: abc' });

    const err = (await decodeError(res)) as AppError;

    expect(err.kind).toBe('notFound');
    expect(err.message).toBe('Customer not found: abc');
  });

  it('passes through structured details (e.g. Zod field errors)', async () => {
    const res = jsonResponse(400, {
      error: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      details: { fields: { name: ['Required'] } },
    });

    const err = (await decodeError(res)) as AppError;

    expect(err.kind).toBe('validation');
    expect(err.details).toEqual({ fields: { name: ['Required'] } });
  });

  it('maps a 401 UNAUTHORIZED body to kind unauthorized', async () => {
    const res = jsonResponse(401, { error: 'UNAUTHORIZED', message: 'Authentication required' });

    const err = (await decodeError(res)) as AppError;

    expect(err.kind).toBe('unauthorized');
    expect(err.message).toBe('Authentication required');
  });

  it('falls back to a status-derived kind + typed message for a non-JSON body', async () => {
    const res = new Response('<html>502 Bad Gateway</html>', { status: 502 });

    const err = (await decodeError(res)) as AppError;

    expect(err.kind).toBe('server');
    // No backend message available → typed fallback, never `HTTP 502`.
    expect(err.message).not.toContain('502');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('falls back to the status when the body is empty', async () => {
    const res = new Response(null, { status: 403 });

    const err = (await decodeError(res)) as AppError;

    expect(err.kind).toBe('forbidden');
  });

  it('derives the kind from status when the JSON has no recognized error code', async () => {
    const res = jsonResponse(409, { message: 'Already approved' });

    const err = (await decodeError(res)) as AppError;

    expect(err.kind).toBe('conflict');
    expect(err.message).toBe('Already approved');
  });

  it('classifies a "Network request failed" throw as offline', () => {
    const err = decodeError(new Error('Network request failed')) as AppError;

    expect(err.kind).toBe('offline');
  });

  it('classifies a timeout abort as timeout', () => {
    const err = decodeError(makeTimeoutError()) as AppError;

    expect(err.kind).toBe('timeout');
  });

  it('re-throws the sign-out AbortError unchanged (never reclassified)', () => {
    const abort = makeUnauthenticatedAbort();

    expect(() => decodeError(abort)).toThrow(abort);
  });

  it('classifies an unrecognized throw as unknown, preserving its message', () => {
    const err = decodeError(new Error('boom')) as AppError;

    expect(err.kind).toBe('unknown');
    expect(err.message).toBe('boom');
  });
});
