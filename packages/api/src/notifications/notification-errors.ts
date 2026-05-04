export type DeliveryErrorCode = 'AUTH_FAILED' | 'PROVIDER_FAILED';

export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode;
  readonly status?: number;
  readonly providerBody?: string;
  readonly retryAfterSeconds?: number;
  readonly providerRequestId?: string;

  constructor(
    code: DeliveryErrorCode,
    message: string,
    options?: {
      status?: number;
      providerBody?: string;
      retryAfterSeconds?: number;
      providerRequestId?: string;
    }
  ) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    this.status = options?.status;
    this.providerBody = options?.providerBody;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.providerRequestId = options?.providerRequestId;
  }
}
