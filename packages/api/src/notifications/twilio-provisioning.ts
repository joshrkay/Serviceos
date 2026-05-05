import type { ProvisioningRequestContext } from './provisioning-context';

export interface TwilioProvisionPhoneNumberInput {
  tenantId: string;
  areaCode: string;
}

export interface TwilioReleasePhoneNumberInput {
  tenantId: string;
  phoneNumberSid: string;
}

export interface TwilioProvisioningClient {
  provisionPhoneNumber(
    input: TwilioProvisionPhoneNumberInput,
    context?: ProvisioningRequestContext,
  ): Promise<{ phoneNumberSid: string; e164: string }>;
  releasePhoneNumber(
    input: TwilioReleasePhoneNumberInput,
    context?: ProvisioningRequestContext,
  ): Promise<void>;
}

export async function provisionTwilioPhoneNumber(
  client: TwilioProvisioningClient,
  input: TwilioProvisionPhoneNumberInput,
  context?: ProvisioningRequestContext,
): Promise<{ phoneNumberSid: string; e164: string }> {
  return client.provisionPhoneNumber(input, context);
}

export async function releaseTwilioPhoneNumber(
  client: TwilioProvisioningClient,
  input: TwilioReleasePhoneNumberInput,
  context?: ProvisioningRequestContext,
): Promise<void> {
  await client.releasePhoneNumber(input, context);
}

export interface TwilioNumbersSdk {
  create(
    input: TwilioProvisionPhoneNumberInput,
    options: { signal?: AbortSignal; timeout?: number; idempotencyKey?: string },
  ): Promise<{ sid: string; phoneNumber: string }>;
  release(
    input: TwilioReleasePhoneNumberInput,
    options: { signal?: AbortSignal; timeout?: number; idempotencyKey?: string },
  ): Promise<void>;
}

export function createTwilioProvisioningAdapter(
  sdk: TwilioNumbersSdk,
): TwilioProvisioningClient {
  return {
    async provisionPhoneNumber(input, context) {
      const result = await sdk.create(input, {
        signal: context?.signal,
        timeout: context?.timeoutMs,
        idempotencyKey: context?.requestId,
      });
      return { phoneNumberSid: result.sid, e164: result.phoneNumber };
    },
    async releasePhoneNumber(input, context) {
      await sdk.release(input, {
        signal: context?.signal,
        timeout: context?.timeoutMs,
        idempotencyKey: context?.requestId,
      });
    },
  };
}
