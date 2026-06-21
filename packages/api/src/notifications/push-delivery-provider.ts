/**
 * Push delivery provider — a notification to a single device token.
 *
 * Deliberately PARALLEL to (not part of) `MessageDeliveryProvider`: that
 * interface is SMS/email only. Unlike per-tenant Twilio credentials, push
 * uses a single APP-GLOBAL credential (one Firebase service account / APNs
 * key, like SendGrid). Tenant isolation lives entirely in token selection
 * (RLS on `device_tokens`), never in credentials — so there is no
 * per-tenant provider resolution here.
 *
 * Production swaps in an FCM provider (firebase-admin) when the service
 * account is configured; dev/test use the in-memory recorder below.
 */
import type { DevicePlatform } from '@ai-service-os/shared';

export interface PushMessage {
  token: string;
  platform: DevicePlatform;
  title: string;
  body: string;
  /** String-only data bag (deep-link target, entity ids, …). */
  data?: Record<string, string>;
}

export interface PushSendResult {
  token: string;
  success: boolean;
  /** True when the provider reports the token is no longer valid (prune it). */
  unregistered?: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface PushDeliveryProvider {
  sendPush(message: PushMessage): Promise<PushSendResult>;
}

/**
 * Records would-be pushes without sending bytes. The wired default until the
 * FCM provider + Firebase project ship (Mac/CI phase). Safe in every env:
 * push is a non-critical channel and stays dormant until a mobile client
 * registers tokens, so we record rather than throw.
 *
 * Tests can pre-seed `unregisteredTokens` to exercise the dead-token prune.
 */
export class InMemoryPushDeliveryProvider implements PushDeliveryProvider {
  readonly sent: PushMessage[] = [];

  constructor(private readonly unregisteredTokens: Set<string> = new Set()) {}

  async sendPush(message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    if (this.unregisteredTokens.has(message.token)) {
      return { token: message.token, success: false, unregistered: true };
    }
    return {
      token: message.token,
      success: true,
      providerMessageId: `mem-push-${this.sent.length}`,
    };
  }

  reset(): void {
    this.sent.length = 0;
  }
}
