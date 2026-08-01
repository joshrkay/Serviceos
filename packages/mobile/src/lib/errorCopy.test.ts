import { describe, expect, it } from 'vitest';
import type { AppError, AppErrorKind } from './appError';
import {
  copyForError,
  MIC_PERMISSION_COPY,
  PUSH_DENIED_COPY,
  type ErrorCopy,
} from './errorCopy';

const ALL_KINDS: AppErrorKind[] = [
  'offline',
  'timeout',
  'unauthorized',
  'forbidden',
  'notFound',
  'conflict',
  'validation',
  'server',
  'unknown',
];

// Kinds where a plain Retry can't help: re-auth / a different request is needed.
const NON_RETRYABLE: AppErrorKind[] = ['unauthorized', 'forbidden', 'notFound'];

function nonEmpty(copy: ErrorCopy): boolean {
  return copy.title.trim().length > 0 && copy.body.trim().length > 0;
}

describe('copyForError', () => {
  it('maps every AppError kind to a non-empty title + body', () => {
    for (const kind of ALL_KINDS) {
      // No backend message → the taxonomy body is used.
      const err: AppError = { kind, message: '' };
      const copy = copyForError(err);
      expect(nonEmpty(copy), `kind ${kind} has non-empty copy`).toBe(true);
    }
  });

  it('sets retryable correctly for the whole taxonomy', () => {
    for (const kind of ALL_KINDS) {
      const copy = copyForError({ kind, message: '' });
      const expected = !NON_RETRYABLE.includes(kind);
      expect(copy.retryable, `kind ${kind} retryable`).toBe(expected);
    }
  });

  it('prefers the backend message as the body when present (still in-voice)', () => {
    const err: AppError = { kind: 'notFound', message: 'Customer not found: abc' };
    const copy = copyForError(err);
    expect(copy.body).toBe('Customer not found: abc');
    // The title is still the taxonomy headline (never the raw message).
    expect(copy.title).not.toBe(copy.body);
  });

  it('falls back to taxonomy body when the AppError message is blank', () => {
    const withMsg = copyForError({ kind: 'server', message: '   ' });
    const blank = copyForError({ kind: 'server', message: '' });
    expect(withMsg.body).toBe(blank.body);
    expect(withMsg.body.trim().length).toBeGreaterThan(0);
  });

  it('treats a raw string as unknown, surfacing it as the body', () => {
    const copy = copyForError('HTTP 500');
    expect(copy.body).toBe('HTTP 500');
    expect(copy.retryable).toBe(true); // unknown is retryable
    expect(copy.title.trim().length).toBeGreaterThan(0);
  });

  it('treats a bare Error as unknown, surfacing its message', () => {
    const copy = copyForError(new Error('boom'));
    expect(copy.body).toBe('boom');
  });

  it('falls back to the unknown copy for an empty string / null / undefined', () => {
    const base = copyForError({ kind: 'unknown', message: '' });
    expect(copyForError('')).toEqual(base);
    expect(copyForError(null)).toEqual(base);
    expect(copyForError(undefined)).toEqual(base);
  });

  it('never surfaces an HTTP status code in any taxonomy copy', () => {
    for (const kind of ALL_KINDS) {
      const copy = copyForError({ kind, message: '' });
      expect(/\b\d{3}\b/.test(copy.title + copy.body)).toBe(false);
    }
  });
});

describe('permission copy', () => {
  it('provides non-empty mic + push copy', () => {
    expect(nonEmpty(MIC_PERMISSION_COPY)).toBe(true);
    expect(nonEmpty(PUSH_DENIED_COPY)).toBe(true);
    expect(MIC_PERMISSION_COPY.retryable).toBe(false);
    expect(PUSH_DENIED_COPY.retryable).toBe(false);
  });
});
