# Local dev: voice-to-action pipeline

How to test the voice-to-action flows end-to-end on your machine. Three paths by
increasing fidelity — pick the one that matches what you actually have.

## Path A — zero credentials: CLI harness (fastest)

Best for wiring checks, regression smoke-tests, showing the flow to someone who
doesn't have prod access.

```bash
cd packages/api

# Transcript that should classify as unknown (mock LLM)
npx ts-node scripts/test-voice.ts "create an invoice for Acme for 450"
# → NO PROPOSAL CREATED (mock returns unknown)

# Scripted LLM responses — simulate the full chain without any external call
MOCK_RESPONSES='[
  {"intentType":"create_invoice","confidence":0.92,"extractedEntities":{"customerName":"Acme"}},
  {"customerId":"c-1","jobId":"j-1","lineItems":[{"description":"Repair","quantity":1,"unitPrice":45000}],"confidence_score":0.92}
]' npx ts-node scripts/test-voice.ts "Create an invoice for Acme for 450"
# → Prints the generated draft_invoice proposal JSON
```

Each `MOCK_RESPONSES` entry is consumed in order. The first call is the intent
classifier, the second is the task handler. See `scripts/test-voice.ts` for more
examples covering all 6 shipped voice flows.

## Path B — real LLM, no UI, no DB

You have an OpenAI (or OpenAI-compatible) key and just want to see the real
classifier pick the right intent.

```bash
cd packages/api
AI_PROVIDER_API_KEY=sk-... \
AI_PROVIDER_BASE_URL=https://api.openai.com/v1 \
AI_DEFAULT_MODEL=gpt-4o-mini \
  npx ts-node scripts/test-voice.ts "schedule a follow-up with Mrs Lee next Tuesday at 2pm"
```

The real LLM runs. The classifier picks `create_appointment`, the task handler
resolves "next Tuesday at 2pm" to an ISO datetime, and a real proposal prints.
Proposals still live in an in-memory repo — no DB needed.

## Path C — full local stack (browser UI included)

You have a Clerk test instance + an AI key and want to exercise the product the
way a real user would.

### Setup (once)

```bash
# 1. Workspace deps — npm workspaces hoists to root node_modules
npm install

# 2. API env
cp packages/api/.env.example packages/api/.env
# Edit packages/api/.env:
#   NODE_ENV=dev
#   AI_PROVIDER_API_KEY=sk-...       (real key)
#   CLERK_SECRET_KEY=sk_test_...     (Clerk dashboard)
#   CLERK_WEBHOOK_SECRET=whsec_...   (any value works until you wire Svix)

# 3. Web env
cp packages/web/.env.example packages/web/.env.local
# Edit packages/web/.env.local:
#   VITE_CLERK_PUBLISHABLE_KEY=pk_test_...

# 4. (optional) Postgres for real persistence
# Without this the API falls back to InMemory and warns loudly at startup.
# DATABASE_URL=postgres://localhost:5432/serviceos
```

### Run

Two terminals:

```bash
# Terminal 1 — API
cd packages/api && npm run dev
# ServiceOS API running on http://localhost:3000
```

```bash
# Terminal 2 — web
cd packages/web && npm run dev
# VITE v5.x ready on http://localhost:5173
```

Open http://localhost:5173, sign up via the Clerk form, and you land on the app
shell. Record a voice note — the transcription worker runs every 250ms, the
voice-action-router picks up the transcript, classifies the intent, and a
proposal appears in your inbox within seconds.

### What to record

| Say | Expect |
|---|---|
| "Create an invoice for Acme Plumbing for 450 dollars" | `draft_invoice` proposal |
| "Draft an estimate for the Johnson water heater job" | `draft_estimate` proposal |
| "Schedule a follow-up with Mrs Lee next Tuesday at 2pm" | `create_appointment` proposal, LLM-parsed ISO time |
| "Add a trip fee to invoice INV-0042" | `update_invoice` proposal (add_line_item) |
| "Remove the heater from estimate EST-0001" | `update_estimate` proposal (remove_line_item) |
| "Send invoice INV-0042" | Nothing — classifies as `unknown`, dropped (Phase 3) |
| "When is my next appointment?" | Nothing — Phase 4 territory |

## What's blocked without credentials

- **Browser UI.** `packages/web/src/main.tsx` throws at module load if
  `VITE_CLERK_PUBLISHABLE_KEY` is missing. Intentional — the P0-026 startup guard.
- **Real voice classification.** Without `AI_PROVIDER_API_KEY` every transcript
  classifies as `unknown` (the MockLLMProvider returns canned JSON).
- **Data persistence across restarts.** Without `DATABASE_URL` the API uses
  InMemory repos and warns loudly on boot. Fine for Path A + B, breaks Path C
  after a restart.

## Troubleshooting

**API won't boot, `CORS_ORIGIN` missing.**
Only required in `NODE_ENV=prod` or `staging`. Set `NODE_ENV=dev` in `.env`.

**Web won't build, `VITE_CLERK_PUBLISHABLE_KEY is required`.**
See Path C setup — `.env.local` in `packages/web/`.

**Voice transcripts all come back as "unknown" in the dev env.**
Either `AI_PROVIDER_API_KEY` isn't set, or the transcript actually is ambiguous.
Check the API log — the router logs the classifier's reasoning field when it
drops a transcript.

**Transcription returns `[Dev mode] Transcription not available...`.**
The API's transcription provider falls back to a no-op stub when
`AI_PROVIDER_API_KEY` isn't set. Set the key to enable real Whisper.
