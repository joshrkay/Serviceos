import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 400, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} not found: ${id}`, 404);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Authentication required') {
    super('UNAUTHORIZED', message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Insufficient permissions') {
    super('FORBIDDEN', message, 403);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
    this.name = 'ConflictError';
  }
}

export function toErrorResponse(err: unknown): { statusCode: number; body: Record<string, unknown> } {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      body: {
        error: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    };
  }

  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      body: {
        error: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: { fields: err.flatten().fieldErrors },
      },
    };
  }

  // body-parser errors (malformed JSON → 'entity.parse.failed', oversized
  // payload → 'entity.too.large') are client faults. Reporting them as 500
  // masks them as server errors — clients then retry a permanently-bad
  // request and alerting fires on what is really a 400/413. Matched on
  // body-parser's `type` discriminator (not a generic statusCode field) so
  // thrown upstream SDK errors keep their existing 500 mapping.
  if (err && typeof err === 'object' && 'type' in err) {
    const type = (err as { type?: unknown }).type;
    if (type === 'entity.too.large') {
      return {
        statusCode: 413,
        body: { error: 'PAYLOAD_TOO_LARGE', message: 'Request payload too large' },
      };
    }
    if (typeof type === 'string' && type.startsWith('entity.')) {
      return {
        statusCode: 400,
        body: { error: 'BAD_REQUEST', message: 'Malformed request body' },
      };
    }
  }

  return {
    statusCode: 500,
    body: {
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  };
}
