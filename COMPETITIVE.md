# Competitive — ServiceOS inbound voice vs. Avoca

Measured on the parity branch against Avoca's published demo bar. Numbers are
from the deterministic gates (`npm run bench:latency`, `npm run test:booking-rate`,
the voice fixture corpus); see "How measured" for what each number includes.

| Bar (Avoca) | Target | ServiceOS measured | Verdict |
|-------------|--------|--------------------|---------|
| Pickup latency (ring → first AI utterance) | < 2000ms | p50 0.001ms / p95 0.002ms / p99 0.004ms (server-controllable assembly, n=1000) | ✅ within budget |
| Booking rate on fixtures | > 75% (Avoca markets 85–90%) | **100%** (8/8 bookable; EN 6/6, ES 2/2) | ✅ |
| Emergency escalation latency (intent → human-dial trigger) | < 5000ms | p50 0.004ms / p95 0.010ms (decision + dispatcher context, n=1000) | ✅ within budget |
| Confidence-threshold handoff (< 0.7 on booking/payment/complaint) | offer transfer | `decideCriticalHandoff` enforces 0.7 on the critical set | ✅ |
| Bilingual EN + ES at parity | parity | Booking ES 100% = EN; detection ES 10/10, EN 16/20, **zero cross-language errors** | ✅ booking parity; ⚠️ short-utterance detection |
| No double-book / no out-of-hours | hard rule | 0 collisions, 0 out-of-hours across corpus + 100 randomized calendars | ✅ |

## How measured (and what is NOT included)

**Pickup & emergency latency** measure only the *in-process, server-controllable*
work — persona resolution (cache hit) + disclosure + greeting assembly for
pickup; dial decision + dispatcher whisper/SMS/panel assembly for emergency.
They deliberately EXCLUDE the dominant real-world costs: PSTN/Twilio call setup,
WebSocket media transit, STT (Deepgram/Whisper) first-token, and TTS
(ElevenLabs) synthesis. Those are out-of-process and are exercised by the
staging load harness (`npm run voice-load:staging`), not by a unit gate. The
gate exists to catch *code-path* regressions; the end-to-end wall-clock budget
is owned by staging. **Demo risk: the headline "< 2s" number a buyer hears is
end-to-end, and our code-path slice is a small fraction of it — the real number
depends on Deepgram/ElevenLabs/Twilio, which this gate does not prove.**

**Booking rate** runs the REAL scheduling engine (`findBookableSlots` →
`isSlotFree` → overlap guard → after-hours flag) over the fixture calendars, so
the rate reflects production logic. The corpus is bookable-demand calls; a
separate assertion confirms the engine correctly *declines* when there is no
availability or the window is in the past.

**Language detection** is offline `franc-min` (microsecond, synchronous). It is
strong on full Spanish sentences (10/10) and weaker on short English phrases
(16/20 — a few confused with Dutch/French) but it **never crossed EN↔ES** on the
corpus. Production does not rely on detection alone: `default_language` +
`auto_detect_language` config and a pre-bias from `customers.preferred_language`
back it up.

## Top 3 demo risks vs. Avoca (side-by-side)

1. **Voice quality / latency is provider-bound.** Avoca's ElevenLabs Turbo +
   tuned Deepgram pipeline sounds noticeably snappier than a default config. Our
   code path is fast, but the buyer hears the *vendor* pipeline. Mitigation:
   pin ElevenLabs Multilingual v2 / Turbo and Deepgram nova-3, and publish the
   staging end-to-end p95, not just the code-path p95.
2. **Spanish at "parity" is booking-parity, not conversational-parity.** Booking
   rate matches and copy is fully localized, but our ASR/intent quality on
   accented Spanish is unverified end-to-end (the Layer-2 voice-quality corpus
   is mostly EN). Avoca demos bilingual confidently. Mitigation: expand the
   Layer-2 ES corpus before a bilingual demo.
3. **No first-class "complaint" classifier intent.** We added the 0.7 handoff
   rule for the complaint family, but the underlying classifier still routes
   complaints via `add_note` / low-confidence escalation rather than a dedicated
   intent. A demo that pokes at an angry caller may show a softer handoff than
   Avoca's. Mitigation: add `complaint` to the classifier taxonomy (small, but
   touches the classifier prompt — out of this pass's scope).
