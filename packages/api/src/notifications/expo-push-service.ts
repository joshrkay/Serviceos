import {
  type PushDeliveryProvider,
  type PushMessage,
  type PushSendResult,
} from './push-delivery-provider';

/** Expo push send endpoint. */
export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts up to 100 messages per request. */
const CHUNK_SIZE = 100;

type FetchLike = typeof fetch;

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Production push provider — batches messages to Expo's send API and maps each
 * ticket back to a result. A ticket carrying `details.error === 'DeviceNotRegistered'`
 * flags a dead token the notifier prunes. Receipt polling (async delivery
 * confirmation) is a follow-up; ticket-level errors already cover token pruning.
 */
export class ExpoPushDeliveryProvider implements PushDeliveryProvider {
  /** Provider literal for observability / cost accounting. */
  readonly provider = 'push-gateway';

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly accessToken?: string,
  ) {}

  async sendPush(messages: PushMessage[]): Promise<PushSendResult[]> {
    const results: PushSendResult[] = [];
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      const chunk = messages.slice(i, i + CHUNK_SIZE);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

      let res: Response;
      try {
        res = await this.fetchImpl(EXPO_PUSH_SEND_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(
            chunk.map((m) => ({ to: m.to, title: m.title, body: m.body, data: m.data })),
          ),
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : 'network error';
        for (const m of chunk) results.push({ to: m.to, ok: false, error, deviceNotRegistered: false });
        continue;
      }

      if (!res.ok) {
        for (const m of chunk) {
          results.push({ to: m.to, ok: false, error: `HTTP ${res.status}`, deviceNotRegistered: false });
        }
        continue;
      }

      const body = (await res.json()) as { data?: ExpoTicket[] };
      const tickets = body.data ?? [];
      chunk.forEach((m, idx) => {
        const ticket = tickets[idx];
        if (ticket && ticket.status === 'ok') {
          results.push({ to: m.to, ok: true, ticketId: ticket.id, deviceNotRegistered: false });
        } else {
          results.push({
            to: m.to,
            ok: false,
            error: ticket?.message ?? 'no ticket returned',
            deviceNotRegistered: ticket?.details?.error === 'DeviceNotRegistered',
          });
        }
      });
    }
    return results;
  }
}
