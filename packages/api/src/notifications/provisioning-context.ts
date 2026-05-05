export interface ProvisioningRequestContext {
  signal?: AbortSignal;
  timeoutMs?: number;
  requestId?: string;
}
