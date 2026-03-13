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

  // Zod validation errors
  if (err != null && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown[] }).issues)) {
    const zodErr = err as { issues: Array<{ path: (string | number)[]; message: string }> };
    return {
      statusCode: 400,
      body: {
        error: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { issues: zodErr.issues.map(i => ({ path: i.path, message: i.message })) },
      },
    };
  }

  // Business-logic validation errors thrown as plain Error
  if (err instanceof Error && err.message.startsWith('Validation failed')) {
    return {
      statusCode: 400,
      body: {
        error: 'VALIDATION_ERROR',
        message: err.message,
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  };
}
