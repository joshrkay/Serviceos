import {
  healthResponseSchema,
  errorResponseSchema,
  createTenantSchema,
  createUserSchema,
  uploadFileSchema,
  createAiRunSchema,
  createMessageSchema,
} from '../../src/shared/contracts';
import { validate } from '../../src/shared/validation';
import { AppError, ValidationError, toErrorResponse } from '../../src/shared/errors';

describe('P0-005 — Backend service skeleton and shared contracts', () => {
  it('happy path — healthResponseSchema validates correct input', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      version: '1.0.0',
      environment: 'dev',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('validation — healthResponseSchema rejects invalid status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'unknown',
      version: '1.0.0',
      environment: 'dev',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('happy path — createUserSchema validates correct input', () => {
    const result = createUserSchema.safeParse({
      email: 'test@example.com',
      role: 'technician',
    });
    expect(result.success).toBe(true);
  });

  it('validation — createUserSchema rejects invalid role', () => {
    const result = createUserSchema.safeParse({
      email: 'test@example.com',
      role: 'admin',
    });
    expect(result.success).toBe(false);
  });

  it('validation — validate throws ValidationError on bad data', () => {
    expect(() =>
      validate(createTenantSchema, { ownerEmail: 'not-email', name: '' })
    ).toThrow(ValidationError);
  });

  it('happy path — validate passes on good data', () => {
    const result = validate(createTenantSchema, {
      ownerEmail: 'test@example.com',
      name: 'My Org',
    });
    expect(result.ownerEmail).toBe('test@example.com');
  });

  it('happy path — toErrorResponse formats AppError', () => {
    const err = new AppError('TEST_ERROR', 'Something went wrong', 422);
    const response = toErrorResponse(err);
    expect(response.statusCode).toBe(422);
    expect(response.body.error).toBe('TEST_ERROR');
  });

  it('happy path — toErrorResponse formats unknown error', () => {
    const response = toErrorResponse(new Error('random'));
    expect(response.statusCode).toBe(500);
    expect(response.body.error).toBe('INTERNAL_ERROR');
  });
});
