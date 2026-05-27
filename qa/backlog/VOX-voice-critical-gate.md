# Voice-Critical Gate — backlog tracker

**Gate policy:** 20/20 rows in `VOICE_CRITICAL_IDS` (`e2e/qa-matrix/gates.ts`) must
be harness `pass`. `partial`, `fail`, `na`, and missing manifests all fail the
hard gate. No waivers without dated executive sign-off.

**Due date for green gate:** 2026-06-10 (14 days from gate implementation)

## Rows previously tolerant of partial — now hard-fail

| Row | Prior behavior | Remediation |
|-----|----------------|-------------|
| CUST-02 | `partial` when LLM/worker missing | Ensure `AI_PROVIDER_API_KEY` + execution worker on Railway dev |
| SCH-02 | `partial` on execution miss | Fix entity resolution + worker; spec now fails loudly |
| SCH-03 | `partial` on cancel resolution | Voice must resolve target appointment |
| VOX-01 | soft keyword → `partial` | Tighten escalation signals or classifier |
| VOX-02 | soft Spanish check → `partial` | i18n response path must return Spanish markers |
| VOX-03 | `na` without RW DB | Doctor + precheck require `E2E_DB_URL_READWRITE` |

## New voice billing + linkage rows (VOX-05..11)

| Row | Workflow | Ticket |
|-----|----------|--------|
| VOX-05 | Voice estimate draft | Wire voice → create_estimate proposal + execution |
| VOX-06 | Voice estimate send | Wire send_estimate via voice approval path |
| VOX-07 | Voice invoice create | Wire create_invoice proposal from voice |
| VOX-08 | Voice invoice issue | Wire issue_invoice from voice |
| VOX-09 | Interactions timeline | Ensure `voice_sessions` persisted before interactions list |
| VOX-10 | Session DB linkage | `voice_sessions` row on in-app session start |
| VOX-11 | Proposal in inbox | Voice proposals must appear in `/api/proposals/inbox` |

## Verify

```bash
npm run e2e:qa-matrix -- --grep "CUST-02|VOX-05|VOX-11"
npm run qa:matrix:gate -- --voice-only
```
