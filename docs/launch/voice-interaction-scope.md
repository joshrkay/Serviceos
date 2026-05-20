# Voice interaction scope — launch vs post-launch

## Launch target: push-to-talk (PTT)

In-app voice at launch is **tap → record → release → upload → transcribe → text command**. No live microphone streaming or barge-in on the web client.

| Surface | Implementation |
|---------|----------------|
| Owner assistant | `VoiceBar`, `VoiceRecorder` |
| Technician job notes | `VoiceUpdate`, `MobileTechView` |
| Dispatcher intake (optional) | `ConversationalIntake` + `VoiceRecorder` |

Data path: audio blob → signed upload → `POST /api/voice/recordings` → poll transcript → assistant / proposal flow.

## Post-launch: conversational in-app

Deferred until after self-serve GA:

- Streaming STT on the web client
- Streaming TTS with barge-in
- Live mic on `VoiceSessionPanel` / `useVoiceSession`
- Voice-based proposal approval (launch uses screen tap)

Scaffolding exists (`inapp-adapter.ts`, `voice-sessions` routes) for telephony parity; do not wire live mic without a dedicated story.

## Telephony (launch)

Inbound calls may use Twilio Media Streams (streaming STT/TTS + barge-in) when `TWILIO_MEDIA_STREAMS_ENABLED` is set. Gather-mode fallback remains the default when streams are off.

This is **phone conversational**, not in-app conversational — separate capacity and alerting paths (`path=voice` in Sentry).

## Reference

- [docs/superpowers/specs/2026-05-14-serviceos-launch-readiness-design.md](../superpowers/specs/2026-05-14-serviceos-launch-readiness-design.md) §2
