import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  toErrorResponse,
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '../../src/shared/errors';

describe('toErrorResponse', () => {
  it('maps a ZodError to 400 with per-field details', () => {
    const schema = z.object({
      customerId: z.string().min(1),
      amountCents: z.number().int().positive(),
    });
    let caught: unknown;
    try {
      schema.parse({ customerId: '', amountCents: -1 });
    } catch (err) {
      caught = err;
    }

    const { statusCode, body } = toErrorResponse(caught);
    expect(statusCode).toBe(400);
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body).toHaveProperty('details');
    const details = body.details as { fields: Record<string, string[]> };
    expect(details.fields).toHaveProperty('customerId');
    expect(details.fields).toHaveProperty('amountCents');
  });

  it('preserves AppError status codes and details', () => {
    const res = toErrorResponse(new ValidationError('Invalid email', { field: 'email' }));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.message).toBe('Invalid email');
    expect(res.body.details).toEqual({ field: 'email' });
  });

  it('maps NotFoundError to 404', () => {
    const res = toErrorResponse(new NotFoundError('Customer', 'abc'));
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('maps ForbiddenError to 403', () => {
    const res = toErrorResponse(new ForbiddenError());
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('falls back to 500 INTERNAL_ERROR for unknown throwables', () => {
    const res = toErrorResponse(new Error('oops'));
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });
});
