/**
 * Minimal Expo push sender.
 *
 * The mobile app registers its Expo token via `POST /api/devices/push-token`
 * (see `devices/device-token.ts`); this is the send side — a plain POST to
 * Expo's public push endpoint. As with the Twilio provider we deliberately
 * skip the `expo-server-sdk` dependency: the request shape is a JSON array of
 * `{ to, title, body }` and nothing more.
 *
 * Best-effort by contract: `send` NEVER throws and never rejects. Push is an
 * additional alert channel layered on top of SMS — a dead Expo endpoint must
 * not take down the E1 life-safety fan-out that calls it.
 */
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'expo-push-sender',
  environment: process.env.NODE_ENV || 'development',
});

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/** Same 4s ceiling the SMS path uses — an alert channel never blocks a caller. */
const EXPO_PUSH_TIMEOUT_MS = 4000;

/** Expo accepts at most 100 messages per request. */
const EXPO_PUSH_MAX_BATCH = 100;

export interface ExpoPushMessage {
  /** An `ExponentPushToken[...]` value. */
  to: string;
  title: string;
  body: string;
}

export interface ExpoPushSender {
  /** Fan a batch of notifications out to Expo. Never throws. */
  send(messages: ExpoPushMessage[]): Promise<void>;
}

export interface ExpoPushSenderOptions {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests. Defaults to Expo's public endpoint. */
  endpoint?: string;
}

export function createExpoPushSender(options: ExpoPushSenderOptions = {}): ExpoPushSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? EXPO_PUSH_ENDPOINT;

  return {
    async send(messages: ExpoPushMessage[]): Promise<void> {
      if (messages.length === 0) return;
      for (let i = 0; i < messages.length; i += EXPO_PUSH_MAX_BATCH) {
        const batch = messages.slice(i, i + EXPO_PUSH_MAX_BATCH);
        try {
          const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(batch),
            signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
          });
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            logger.warn('expo push: send rejected', {
              status: response.status,
              providerBody: text.slice(0, 300),
              count: batch.length,
            });
          }
        } catch (err) {
          // Timeout / network / abort — swallowed on purpose (see the module
          // docstring): push is a secondary channel.
          logger.warn('expo push: send failed', {
            error: err instanceof Error ? err.message : String(err),
            count: batch.length,
          });
        }
      }
    },
  };
}
