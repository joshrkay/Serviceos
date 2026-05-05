import type { ProvisioningRequestContext } from './provisioning-context';

export interface SendgridCreateSubuserInput {
  tenantId: string;
  username: string;
  email: string;
}

export interface SendgridDeleteSubuserInput {
  tenantId: string;
  username: string;
}

export interface SendgridProvisioningClient {
  createSubuser(
    input: SendgridCreateSubuserInput,
    context?: ProvisioningRequestContext,
  ): Promise<{ subuserId: string }>;
  deleteSubuser(
    input: SendgridDeleteSubuserInput,
    context?: ProvisioningRequestContext,
  ): Promise<void>;
}

export async function createSendgridSubuser(
  client: SendgridProvisioningClient,
  input: SendgridCreateSubuserInput,
  context?: ProvisioningRequestContext,
): Promise<{ subuserId: string }> {
  return client.createSubuser(input, context);
}

export async function deleteSendgridSubuser(
  client: SendgridProvisioningClient,
  input: SendgridDeleteSubuserInput,
  context?: ProvisioningRequestContext,
): Promise<void> {
  await client.deleteSubuser(input, context);
}

export interface SendgridSubuserSdk {
  create(
    input: SendgridCreateSubuserInput,
    options: { signal?: AbortSignal; timeout?: number; requestId?: string },
  ): Promise<{ id: string }>;
  delete(
    input: SendgridDeleteSubuserInput,
    options: { signal?: AbortSignal; timeout?: number; requestId?: string },
  ): Promise<void>;
}

export function createSendgridProvisioningAdapter(
  sdk: SendgridSubuserSdk,
): SendgridProvisioningClient {
  return {
    async createSubuser(input, context) {
      const result = await sdk.create(input, {
        signal: context?.signal,
        timeout: context?.timeoutMs,
        requestId: context?.requestId,
      });
      return { subuserId: result.id };
    },
    async deleteSubuser(input, context) {
      await sdk.delete(input, {
        signal: context?.signal,
        timeout: context?.timeoutMs,
        requestId: context?.requestId,
      });
    },
  };
}
