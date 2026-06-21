/**
 * Push delivery provider — the seam between "we decided to notify" and "an HTTP
 * call to a push gateway". Production wraps Expo's push API
 * (ExpoPushDeliveryProvider); tests pass InMemoryPushDeliveryProvider and assert
 * on what would have been sent. Mirrors the SMS/email delivery-provider shape.
 */
export interface PushMessage {
  /** Expo push token (`ExponentPushToken[...]`). */
  to: string;
  title: string;
  body: string;
  /** Tap-routing payload: `{ proposalId, kind, screen }`. */
  data?: Record<string, unknown>;
}

export interface PushSendResult {
  to: string;
  ok: boolean;
  ticketId?: string;
  error?: string;
  /** Token is dead (Expo `DeviceNotRegistered`) — the caller should prune it. */
  deviceNotRegistered: boolean;
}

export interface PushDeliveryProvider {
  sendPush(messages: PushMessage[]): Promise<PushSendResult[]>;
}

export class InMemoryPushDeliveryProvider implements PushDeliveryProvider {
  readonly sent: PushMessage[] = [];
  /** Tokens to report as DeviceNotRegistered, so prune logic can be tested. */
  readonly deadTokens = new Set<string>();

  async sendPush(messages: PushMessage[]): Promise<PushSendResult[]> {
    this.sent.push(...messages);
    return messages.map((m) => ({
      to: m.to,
      ok: !this.deadTokens.has(m.to),
      deviceNotRegistered: this.deadTokens.has(m.to),
    }));
  }
}
