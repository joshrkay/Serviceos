# Voice interaction scope — launch vs post-launch

## Owner assistant: conversational mode (shipped, UB-B)

The owner assistant now supports **streaming conversational voice** in-app
(`AssistantPage` conversation-mode toggle):

- Streaming STT: browser mic → Deepgram over WebSocket
  (`useDeepgramDictation` continuous mode, per-utterance finals via
  `utterance_end_ms`), token-minted per session by
  `POST /api/voice/stream-token` (dedicated per-tenant mint limiter
  `VOICE_STREAM_TOKEN_MINTS_PER_MIN`, default 30/min; every mint audited as
  `voice.stream_token_minted`).
- Spoken replies: browser `speechSynthesis` via `useTTS` (markdown stripped).
- Barge-in: speech while the assistant is talking stops TTS immediately
  (`useConversationVoice`).
- Utterance auto-submit through the existing `POST /api/assistant/chat` path
  with `inputMode: 'voice'`; ~800ms continuation debounce; 60s silence ends
  the session.

The PTT record→poll path remains as the fallback input.

**Voice approval is still deferred** — see below. A voice-mode chat turn that
classifies as approve/reject/edit gets a deterministic refusal ("Tap the card
to approve…") and an `assistant.voice_approval_refused` audit event; it is
never routed to an approval action (RV-071/RV-225 posture unchanged:
approve/reject/edit by voice is owner-telephony only).

## Baseline: push-to-talk (PTT)

In-app voice elsewhere is **tap → record → release → upload → transcribe → text command**.

| Surface | Implementation |
|---------|----------------|
| Owner assistant (fallback) | `VoiceBar`, `VoiceRecorder` |
| Technician job notes | `VoiceUpdate`, `MobileTechView` |
| Dispatcher intake (optional) | `ConversationalIntake` + `VoiceRecorder` |

Data path: audio blob → signed upload → `POST /api/voice/recordings` → poll transcript → assistant / proposal flow.

## Still deferred

- Voice-based proposal approval in-app (screen tap only; telephony owner
  sessions are the sole voice-approval surface — RV-071/RV-225)
- Live mic on `VoiceSessionPanel` / `useVoiceSession`
- Server-side TTS for the assistant (optional `POST /api/assistant/tts`, UB-B4)

Scaffolding exists (`inapp-adapter.ts`, `voice-sessions` routes) for telephony parity; do not wire live mic there without a dedicated story.

## Telephony (launch)

Inbound calls may use Twilio Media Streams (streaming STT/TTS + barge-in) when `TWILIO_MEDIA_STREAMS_ENABLED` is set. Gather-mode fallback remains the default when streams are off.

This is **phone conversational**, not in-app conversational — separate capacity and alerting paths (`path=voice` in Sentry).

## Reference

- [docs/superpowers/specs/2026-05-14-serviceos-launch-readiness-design.md](../superpowers/specs/2026-05-14-serviceos-launch-readiness-design.md) §2
