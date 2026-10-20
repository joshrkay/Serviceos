/**
 * S6-3 (U7 "Only a `Calls` request that provably created no call releases
 * anything at once") — the classification table. Only the closed lists are
 * not-created; everything else, including anything this table does not
 * name, is unconfirmed.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyCallsOutcome,
  NOT_CREATED_CODES,
  NOT_CREATED_RESPONSES,
  type CallsRequestResult,
} from '../../src/demo/twilio-outcome';

const twilioBody = (status: number, code = 21211) =>
  JSON.stringify({ code, message: 'The To number is not a valid phone number.', more_info: 'https://www.twilio.com/docs/errors/21211', status });

const response = (status: number, bodyText: string | null): CallsRequestResult => ({ kind: 'response', status, bodyText });

function fetchFailed(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return new TypeError('fetch failed', { cause });
}

function named(name: string): Error {
  const err = new Error('The operation was aborted');
  err.name = name;
  return err;
}

describe('classifyCallsOutcome — created', () => {
  it('a 201 whose JSON body carries a sid is created, with that sid', () => {
    expect(classifyCallsOutcome(response(201, JSON.stringify({ sid: 'CA0123', status: 'queued' })))).toEqual({
      outcome: 'created',
      callSid: 'CA0123',
    });
  });
  it('any 2xx with a sid is created', () => {
    expect(classifyCallsOutcome(response(200, JSON.stringify({ sid: 'CA9' }))).outcome).toBe('created');
  });
});

describe('classifyCallsOutcome — not created (the closed lists)', () => {
  it('the listed statuses are exactly 400, 401, 403, 404, 429', () => {
    expect([...NOT_CREATED_RESPONSES]).toEqual([400, 401, 403, 404, 429]);
  });

  for (const status of [400, 401, 403, 404, 429]) {
    it(`a Twilio-shaped ${status} body is not created`, () => {
      expect(classifyCallsOutcome(response(status, twilioBody(status)))).toEqual({
        outcome: 'not_created',
        reason: 'twilio_rejected',
        httpStatus: status,
        twilioCode: 21211,
      });
    });
  }

  for (const code of [
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ]) {
    it(`a connection failure ${code} before the request is written is not created`, () => {
      expect(NOT_CREATED_CODES.has(code)).toBe(true);
      expect(classifyCallsOutcome({ kind: 'thrown', error: fetchFailed(code) })).toEqual({
        outcome: 'not_created',
        reason: 'connect_failed',
        causeCode: code,
      });
    });
  }

  it('an AggregateError cause (both address families refused) is not created when every member is listed', () => {
    const agg = Object.assign(new AggregateError([fetchFailed('ECONNREFUSED').cause, fetchFailed('ECONNREFUSED').cause]), {
      code: 'ECONNREFUSED',
    });
    expect(classifyCallsOutcome({ kind: 'thrown', error: new TypeError('fetch failed', { cause: agg }) }).outcome).toBe(
      'not_created',
    );
  });

  it('a local failure (no request was made) is not created', () => {
    expect(classifyCallsOutcome({ kind: 'local_failure', error: new Error('bad From') })).toEqual({
      outcome: 'not_created',
      reason: 'local_failure',
    });
  });
});

describe('classifyCallsOutcome — unconfirmed (everything else)', () => {
  const cases: Array<[string, CallsRequestResult, string]> = [
    ['500', response(500, twilioBody(500, 20500)), 'http_5xx'],
    ['502', response(502, '<html>Bad gateway</html>'), 'http_5xx'],
    ['503', response(503, twilioBody(503, 20503)), 'http_5xx'],
    ['504', response(504, null), 'http_5xx'],
    ['409 with a Twilio body', response(409, twilioBody(409, 20409)), 'unlisted_response'],
    ['a 400 whose body is HTML', response(400, '<html>Bad request</html>'), 'unparsable_body'],
    ['a 400 JSON body without Twilio shape', response(400, JSON.stringify({ error: 'nope' })), 'unlisted_response'],
    ['a 401 whose status field disagrees', response(401, twilioBody(400)), 'unlisted_response'],
    ['a 404 whose code is not a number', response(404, JSON.stringify({ code: '20404', message: 'x', status: 404 })), 'unlisted_response'],
    ['a 2xx without a sid', response(201, JSON.stringify({ status: 'queued' })), 'unparsable_body'],
    ['a 2xx with an empty sid', response(201, JSON.stringify({ sid: '' })), 'unparsable_body'],
    ['a 2xx whose body is truncated', response(201, '{"sid":"CA'), 'unparsable_body'],
    ['a 2xx whose body could not be read', response(201, null), 'unparsable_body'],
    ['a 302', response(302, ''), 'unlisted_response'],
    ['a 422', response(422, twilioBody(422)), 'unlisted_response'],
    ['a timeout', { kind: 'thrown', error: named('TimeoutError') }, 'timeout'],
    ['an abort', { kind: 'thrown', error: named('AbortError') }, 'timeout'],
    ['ECONNRESET after the request was written', { kind: 'thrown', error: fetchFailed('ECONNRESET') }, 'reset_after_send'],
    ['a peer close (UND_ERR_SOCKET)', { kind: 'thrown', error: fetchFailed('UND_ERR_SOCKET') }, 'reset_after_send'],
    ['an unlisted cause.code', { kind: 'thrown', error: fetchFailed('EPROTO') }, 'reset_after_send'],
    ['a fetch failure with no cause', { kind: 'thrown', error: new TypeError('fetch failed') }, 'reset_after_send'],
    ['a thrown non-Error', { kind: 'thrown', error: 'boom' }, 'unlisted_response'],
    ['a thrown null', { kind: 'thrown', error: null }, 'unlisted_response'],
  ];
  for (const [label, input, reason] of cases) {
    it(`${label} is unconfirmed (${reason})`, () => {
      expect(classifyCallsOutcome(input)).toMatchObject({ outcome: 'unconfirmed', reason });
    });
  }

  it('an AggregateError cause with one unlisted member is unconfirmed', () => {
    const agg = new AggregateError([fetchFailed('ECONNREFUSED').cause, fetchFailed('ECONNRESET').cause]);
    expect(classifyCallsOutcome({ kind: 'thrown', error: new TypeError('fetch failed', { cause: agg }) }).outcome).toBe(
      'unconfirmed',
    );
  });

  it('nothing is not-created by default: an unknown result kind is unconfirmed', () => {
    expect(classifyCallsOutcome({ kind: 'mystery' } as unknown as CallsRequestResult).outcome).toBe('unconfirmed');
  });
});
