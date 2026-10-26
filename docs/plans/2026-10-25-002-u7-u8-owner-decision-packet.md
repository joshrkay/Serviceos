# U7 erasure and U8 spend cap: decisions only the owner can make

**Created:** 2026-10-25
**Designs:** [`docs/plans/2026-10-18-002a-u7-data-subject-erasure-design.md`](2026-10-18-002a-u7-data-subject-erasure-design.md) (U7),
[`docs/plans/2026-10-18-002b-u8-ai-spend-cap-design.md`](2026-10-18-002b-u8-ai-spend-cap-design.md) (U8)
**Execution plan:** E7 in [`docs/plans/2026-10-18-003-chore-ai-hardening-execution-plan.md`](2026-10-18-003-chore-ai-hardening-execution-plan.md)

On 2026-10-18 the owner accepted the hardening plan's recommended defaults for decisions 1 (PRIV-5 erasure scope) and 2 (money cap). This is recorded in the execution plan on `main` and was merged in #1696.

The implementation planning on 2026-10-25 found choices those defaults don't cover: the designs name no default for them, or the choice is new since the design was written. Each item below gives a recommended answer. Replying "accept the recommendations", or giving the item numbers to change, is enough.

## U8: money cap on AI spend

1. **Platform default ceiling.** Should a tenant whose owner never sets a monthly AI spend ceiling get a platform default? If so, how many dollars a month, and can an owner raise or remove it?
   - Once #1831 merges (it is still open), the token buckets no longer act as a spend limit, so without a default those tenants have no money limit.
   - A default would apply only after every AI surface is priced, starting the month after the cutover.
   - *Recommendation: yes, with an owner able to raise or remove it. The amount is yours to set.* For scale: #1831's sized load of 25 concurrent sessions costs about $12–13 an hour on gpt-4o-mini. On `main` the token buckets hold one tenant to about $1 an hour on gpt-4o-mini (`packages/api/src/shared/config.ts:257-263`); #1831 raises that bound to about $19 an hour (its PR body).
   - This needs an answer before the first U8 migration, because it decides what an empty ceiling means.
2. **Vapi.** A Vapi call can't be stopped at the cap. Should each call's cost still count toward the monthly ceiling (we'd read it from Vapi after the call ends), or stay outside the cap with the settings page saying so? And is `VAPI_API_KEY` set in production today?
   - *Recommendation: count it.*
3. **Browser dictation.** In-app dictation streams audio from the browser straight to Deepgram on our key, so the server can't meter it. Leave dictation outside the cap and say so on the settings page, or count a fixed amount for each 30-second dictation token and refuse it at the cap?
   - *Proposal, since the design names no default: count a fixed amount per token.*
4. **Spend alert threshold.** The platform AI spend alert pages at $2.00 per 30 minutes, so once #1831 merges, one busy tenant can trigger it alone (see #1831). Keep $2.00, or raise it to about $20.00 so that only a runaway across tenants pages?
   - *Recommendation: $20.00 once U8's per-tenant cap is live, $2.00 until then.*
5. **Media Streams minutes.** Does the cap include Twilio Media Streams minutes on the realtime voice path, or only AI provider charges?
   - *Recommendation: exclude them, and say so on the settings page.*
6. **Spend record retention.** *Recommendation: delete finished per-call spend records after 13 months, and keep the monthly totals.*
7. **What happens at the cap.** Live calls fall back to the hold line or a keypad menu until the 1st of the month or until you raise the cap. Safety lines, such as the 911 line, are never blocked. Only the platform operator is alerted at 80%. Is that right, and should the owner be told at 80% too?
   - *Recommendation: tell the owner as well.*
8. **Confirm that U8 should be built at all.** The decision record says U7 and U8 "may start", but the plan's item 2 names no default. One sentence confirming is enough.

## U7: data-subject erasure

9. **Vapi.** When a customer is erased, should we delete their Vapi calls through Vapi's API, or instead require Vapi's recording and transcript storage to be off and refuse to start otherwise?
   - *Recommendation: delete them through the API.*
10. **ElevenLabs.** ElevenLabs keeps the text it speaks in your account history unless Zero Retention Mode is on. Either (a) turn on Zero Retention Mode, if your plan offers it, and we refuse to start without it, or (b) keep the history and have the erase find and delete the customer's items.
    - *Recommendation: (a) if your plan allows it, otherwise (b).*
11. **Deepgram model improvement (shared with U8).** Should every Deepgram request opt out of Deepgram's model-improvement program? Please check whether opting out changes your Deepgram price.
    - *Recommendation: yes.*
12. **OpenAI zero data retention.** Do you want to ask OpenAI for zero data retention? Until then, each erase result will say OpenAI may keep request content for up to 30 days.
    - This is a vendor request, not code.
13. **Legal hold.** If a customer asks to be erased while one of their call recordings is on legal hold, which wins?
    - *Recommendation: the hold. The held recordings, their transcripts, summaries and AI runs stay. The erase reports them as "held under legal hold" and finishes once the hold is lifted. Please confirm with counsel.*
14. **People with no customer record.** The erase works on a customer record. Should U7 also erase a lead, or a phone number with no customer record (someone who only called, texted or was a lead)?
    - *Recommendation: customer records only in this unit. Lead-only and phone-only subjects come in a follow-up unit with its own design.*
15. **Owner screen.** Should this unit include an owner screen (an erase button that asks you to type the customer's name, plus progress, matches to confirm and held messages), or ship API-only first, run by support?
    - *Recommendation: API-only first.*
16. **Send records outside the request.** A record of each outgoing message will always be saved on its own, even if the rest of the request fails and is undone. This also settles the open P1.6 question from the database audit. OK?
    - *Recommendation: yes.*
17. **Retention windows.** We propose:
    - keep an erased customer's encrypted contact details for at most 30 days;
    - clear stored webhook contents after 90 days;
    - keep failed background jobs for at most 30 days;
    - hold a message we can't attribute for at most 72 hours, or until the appointment starts if that is sooner.

    OK?
18. **Do-not-contact records.** Kept do-not-contact and consent records keep the phone number unhashed, because blocking needs it, unless counsel says otherwise. OK?
19. **Google reviews.** If an erased customer left a Google review that we replied to, should the erase delete our public reply and our stored copy of the review? The review itself belongs to them and stays at Google.
    - *Recommendation: delete our stored copy, and keep our public reply unless you say otherwise.*
20. **QuickBooks receipts (confirm).** Erasing rewrites the customer's QuickBooks sales receipts to remove their name, address and line descriptions. Amounts don't change. Your accountant should agree.

## Actions only the owner can take

- **Production provider and prices.** Which production setup is live: OpenAI direct (gpt-4o-mini) or OpenRouter (Llama/Qwen)? Then put verified prices in `AI_MODEL_PRICING_JSON` for:
  - the live and fallback models;
  - the embedding model, Whisper and OpenAI speech;
  - ElevenLabs;
  - Deepgram, with redaction and the opt-out choice;
  - Twilio speech recognition, and the Twilio Polly/Google voice tiers.

  For reasoning models, also give the most output one request can bill. No cap can be turned on until every one of these is priced.
- **Code owners.** Turn on "Require review from Code Owners" on `main`. Without it, the CODEOWNERS file U7 adds isn't enforced.
- **Langfuse retention.** Set the Langfuse project's retention to no longer than the AI-runs window.
- **Storage notifications.** Set up bucket object-created notifications to a queue, with credentials, or accept a listing-only backstop.
- **CDN purge.** If `STORAGE_PUBLIC_URL` is used, provide CDN purge credentials.
