/**
 * Twilio Media Streams (P8-012) — barrel.
 *
 * Re-exports the public surface so `app.ts` and tests don't have to
 * reach into module-internal paths. The codec is exposed because
 * round-trip tests pin µ-law ↔ PCM identity, and the adapter is
 * exposed for unit tests that drive it with a fake WebSocket.
 */

export {
  mulawToPcm16,
  pcm16ToMulaw,
  upsample8to16,
  downsample16to8,
  decodeTwilioInboundFrame,
  encodeTwilioOutboundFrame,
} from './mulaw-codec';

export {
  TwilioMediaStreamAdapter,
  DEFAULT_AUDIO_IDLE_TIMEOUT_MS,
  type WsLike,
  type TwilioInboundFrame,
  type SpeechTurnHandler,
  type MediaStreamAdapterDeps,
} from './mediastream-adapter';

export {
  attachMediaStreamServer,
  MEDIA_STREAM_PATH,
  type MediaStreamServerDeps,
  type AttachOptions,
} from './twilio-mediastream-server';
