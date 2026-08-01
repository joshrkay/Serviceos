export const meta = {
  name: 'serviceos-audit-discovery',
  description: 'Evidence-grounded ServiceOS audit: per-surface alignment + PRD reconciliation + red-team recon, adversarially verified',
  phases: [
    { title: 'Discovery', detail: 'parallel per-surface auditors + PRD reconciliation + red-team recon' },
    { title: 'Verify', detail: 'fresh-context adversarial verification of high-severity defects' },
  ],
}

const REF = `REFERENCE STANDARD (read projects/serviceos-audit/run-1/01-reference-standard.md for full detail):
- Persona: Mike (2-truck HVAC) / Jenna (solo plumber, B2B property-mgr, MMS). North star: return owner hours, reachable by a spoken sentence while driving.
- Naming: brand=Rivet, product=ServiceOS (PRD-v3.md:1-4).
- Invariants (Guardrail 2): money=integer cents; time UTC stored/tenant-local rendered; every row tenant_id + RLS FORCE; every mutation emits audit event; all AI via LLM gateway only; proposals=typed Zod contracts, human-approved, never auto-executed; AI prices catalog-resolved before proposal; high-stakes outputs pass supervisor agent.
- The docs LAG the code — trust the code. The 2026-06-20 doc docs/prd-v3-code-status.md is a stale seed, re-verify everything against current /packages.`

const RULES = `HARD RULES:
- Cite file:line for EVERY factual claim. Read the actual code (Grep/Read/Glob). Do NOT fabricate paths or line numbers.
- If you cannot verify something, mark it status "unverifiable" — never assert built/aligned/secure without evidence.
- A "defect" must be a concrete, reproducible code problem with a failure scenario, not a style opinion.
- Classify each defect category precisely: money | rls | auth | correctness | brand-voice | persona-fit | idempotency | other.
- Be a skeptic: for each "it works" belief, try to find the code path that breaks it.
- Work only in packages/api, packages/web, packages/shared. Ignore /experiments, /rewrite, /service-os-app, /infra (quarantined, NOT production).`

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['surface', 'summary', 'reconciliation', 'defects'],
  properties: {
    surface: { type: 'string' },
    summary: { type: 'string', description: 'one-paragraph alignment + persona-fit verdict with evidence' },
    personaFit: { type: 'string', enum: ['aligned', 'partial', 'misaligned', 'unverifiable'] },
    reconciliation: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'status', 'evidence'],
        properties: {
          claim: { type: 'string' },
          status: { type: 'string', enum: ['built', 'partial', 'claimed-not-built', 'doc-drift', 'unverifiable'] },
          evidence: { type: 'string', description: 'file:line citation(s)' },
          note: { type: 'string' },
        },
      },
    },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'category', 'evidence', 'failureScenario', 'proposedFix'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string' },
          evidence: { type: 'string', description: 'file:line' },
          failureScenario: { type: 'string' },
          proposedFix: { type: 'string' },
          fixScope: { type: 'string', enum: ['safe', 'money-rls-auth'], description: 'money-rls-auth = must be isolated + held per Guardrail 1(b)' },
        },
      },
    },
  },
}

const REDTEAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['domain', 'attacks'],
  properties: {
    domain: { type: 'string' },
    attacks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['attack', 'targetPath', 'outcome', 'severity'],
        properties: {
          attack: { type: 'string', description: 'the specific attack attempted' },
          targetPath: { type: 'string', description: 'file:line of the code path attacked' },
          outcome: { type: 'string', enum: ['holds', 'leaks', 'uncertain'] },
          repro: { type: 'string', description: 'how to reproduce / the failing assertion' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
        },
      },
    },
  },
}

const auditor = (surface, brief) => agent(
  `${REF}\n\n${RULES}\n\nYou are a per-surface ALIGNMENT AUDITOR. Audit this surface cluster: ${surface}\n\n${brief}\n\nFor each capability: (1) does it exist end-to-end (cite the wiring: route -> handler -> repo/worker)? (2) is it internally consistent + consistent with the PRD and adjacent surfaces? (3) persona-fit — does it return owner hours and is it reachable by voice/SMS? Produce reconciliation rows (claim vs reality with file:line) and a defects list (concrete, reproducible, with proposed fix). Prioritize finding REAL defects over confirming things work.`,
  { label: `audit:${surface.split(' ')[0]}`, phase: 'Discovery', schema: AUDIT_SCHEMA, model: 'sonnet' },
)

const redteam = (domain, brief) => agent(
  `${REF}\n\n${RULES}\n\nYou are a RED TEAM attacker. Domain: ${domain}\n\n${brief}\n\nActively try to BREAK the system by reading the real code paths. Log one attack per attempt with its outcome (holds/leaks/uncertain) and a concrete repro or failing assertion, each with file:line. Invent harder attacks than the examples. A cross-tenant leak or double-charge is CRITICAL. Do not claim a leak you cannot ground in a specific code path.`,
  { label: `redteam:${domain.split(' ')[0]}`, phase: 'Discovery', schema: REDTEAM_SCHEMA, model: 'sonnet' },
)

phase('Discovery')

const discovery = await parallel([
  () => auditor('Onboarding + Settings', 'V2 form wizard AND conversational voice-onboarding lane; deriveOnboardingStatus parity between the two lanes; brand-voice configurator; tech setup; business hours. Check packages/api/src/onboarding, packages/api/src/settings, packages/web onboarding. Is there a conversational onboarding loop or only the form wizard?'),
  () => auditor('Inbound Voice + Operator Voice', 'Inbound: Twilio Media Streams -> Deepgram -> intake/triage (intent classification, vulnerability detector, severity, B2B account recognizer, dropped-call recovery) -> booking proposal. Operator: route-aware VoiceBar -> classifyIntent -> task handlers -> proposals. Check packages/api/src/telephony/media-streams, src/voice, src/ai/orchestration, src/ai/vulnerability, src/ai/triage. Is the B2B account recognizer real (PM type/sub-accounts/routing) or just a binary residential/b2b flag?'),
  () => auditor('Proposal/Approval Engine', 'Zod contracts, confidence markers, Brand-Voice Validator, negotiation guardrails, expiry (48h schedule TTL), supervisor agent, SMS approval transport, idempotency, audit, rollback. Check packages/api/src/proposals/* and src/ai/brand-voice. CRITICAL: is there a post-generation Brand-Voice VALIDATOR (not just the composer) that validates EVERY outbound message? Does every outbound surface route through brand voice? Can a proposal execute without an approved, unexpired proposal? Is the approval endpoint authenticated?'),
  () => auditor('Scheduling/Dispatch + Estimates', 'Scheduling: voice assignment, drive-time feasibility, conflict detection, cascade reschedule (tech I am out). Estimates: vertical packs hvac/plumbing/electrical/PAINTING, catalog resolver, tier options (good/better/best), templates. Check src/scheduling, src/dispatch, src/estimates, src/verticals, src/ai/resolution/catalog-resolver.ts, src/packs. Does the PAINTING vertical pack exist? Are AI prices catalog-resolved before proposal?'),
  () => auditor('Invoicing/Payments + Memberships', 'Auto-invoice on completion, dunning/late fees, Stripe card AND ACH, auto-pay/saved-card off_session, QBO sync. Memberships: recurring, auto-renew off_session. Check src/invoices, src/payments, src/billing, src/integrations/accounting, src/maintenance-contracts, src/recurring-jobs. Is ACH actually configured/exercised or just card? Money must be integer cents everywhere — hunt for float leaks.'),
  () => auditor('Comms/Inbox + Reviews + Field/PWA', 'Two-way SMS, threaded unified inbox, email+voice history, suggest-reply, DNC/consent. Reviews: post-job request, review-gating (4-star->Google), Google polling, draft public/private responses. Field/PWA: tech on-my-way / I am-out, GPS->ETA texts. Check src/messaging, src/conversations, src/sms, src/reputation, src/sms/tech-status, packages/mobile. Are tech ETA texts real (GPS->ETA) or stubbed? Is DNC/consent enforced before every outbound?'),
  () => auditor('Portal + Digest + CRM', 'Client hub/portal: token-gated estimate review, tier select, e-sign, deposit, invoice pay, receipt. Digest: EOD SMS 6-9pm, voice-queryable metrics, correction loop. CRM: multiple contacts, tags/custom fields, billing address, equipment registry, LTV segmentation, multi-location. Check src/portal, src/public-*, src/digest, src/reports, src/customers, src/locations. Portal token auth: can a token for tenant A read tenant B data? Does equipment registry / LTV / multi-location exist?'),
  () => auditor('PRD-vs-code reconciliation gate (seeded overclaims)', 'DEDICATED reconciliation of the KNOWN overclaims + go-live hardening. Confirm CURRENT status of each with file:line, status built/partial/claimed-not-built/doc-drift: (1) MMS-to-quote image->estimate analysis; (2) ACH payments; (3) B2B account recognition; (4) tech ETA texts; (5) Inngest-vs-PgQueue naming/durable-queue; (6) conversational onboarding loop; (7) painting vertical pack; (8) 2-hour delayed thank-you SMS. Re-verify go-live hardening: webhook dedup durability, transaction rollback on 4xx/5xx, RLS FORCE on ALL entity tables (list which tables have it and which do NOT from src/db/schema.ts + migrations), authenticated proposal-approval endpoint, leader-elected cron (runAsLeader), payment audit events. This is the most important agent — be exhaustive and cite every table.'),
  () => redteam('Tenant isolation (RLS)', 'Attempt cross-tenant reads/writes on EVERY entity via the API, the portal token, and the voice paths. Read src/db/schema.ts for which tables have RLS FORCE and which lack it. Check middleware that sets the tenant GUC / runtime role. Find any query that runs as a superuser/owner role bypassing RLS, any repo method missing a tenant_id filter, any portal/public route that trusts a client-supplied tenant/entity id. A leak is CRITICAL.'),
  () => redteam('Money flow', 'Double-charge, negative/zero amounts, replayed Stripe webhooks, race conditions on payment + proposal execution, rounding/float leaks. Read src/payments, src/invoices, src/billing, stripe webhook handler, proposal execution. Is webhook dedup durable (DB-backed, survives restart) or in-memory? Can the same proposal execute twice under concurrent SMS approval delivery? Any Number/float math on money?'),
  () => redteam('Auth / approval bypass', 'Unauthenticated approval, executing an unapproved or expired proposal, privilege confusion across owner/tech/customer. Read the approval endpoints (proposals routes, one-tap-approve, public-* routes), auth middleware, portal token verification. Can you forge an approval? Replay an SMS approve? Approve after expiry? Approve another tenant proposal?'),
  () => redteam('Voice / LLM abuse', 'Prompt injection through a caller (ignore your instructions, book it free), negotiation-guardrail bypass, brand-voice-drift injection, a hallucinated part/price slipping past the catalog resolver + supervisor. Read src/ai/brand-voice, src/conversations/negotiation, src/proposals/guardrails, src/ai/resolution/catalog-resolver.ts, src/proposals/supervisor. Can caller free text reach a system prompt unescaped? Can an uncatalogued line auto-approve?'),
])

const results = discovery.filter(Boolean)
const audits = results.filter(r => r.surface)
const redteams = results.filter(r => r.domain)

const toVerify = []
for (const a of audits) {
  for (const d of (a.defects || [])) {
    if (d.severity === 'critical' || d.severity === 'high') {
      toVerify.push({ kind: 'defect', surface: a.surface, ...d })
    }
  }
}
for (const rt of redteams) {
  for (const at of (rt.attacks || [])) {
    if (at.outcome === 'leaks' || (at.outcome === 'uncertain' && (at.severity === 'critical' || at.severity === 'high'))) {
      toVerify.push({ kind: 'attack', domain: rt.domain, title: at.attack, severity: at.severity, evidence: at.targetPath, failureScenario: at.repro, proposedFix: '' })
    }
  }
}

log(`Discovery: ${audits.length} audits, ${redteams.length} red-team domains, ${toVerify.length} high-severity items to verify`)

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasoning', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'PARTIAL', 'UNVERIFIABLE'] },
    reasoning: { type: 'string' },
    evidence: { type: 'string', description: 'independent file:line citations you personally read' },
    correctedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
    fixScope: { type: 'string', enum: ['safe', 'money-rls-auth'] },
    minimalFix: { type: 'string', description: 'the smallest correct fix, or empty if refuted' },
  },
}

phase('Verify')

const verified = await parallel(toVerify.map((item) => () =>
  agent(
    `${REF}\n\nYou are a FRESH-CONTEXT ADVERSARIAL VERIFIER. Another agent reported this ${item.kind}:\n\nTITLE: ${item.title}\nSEVERITY: ${item.severity}\nCLAIMED EVIDENCE: ${item.evidence}\nFAILURE SCENARIO: ${item.failureScenario}\nPROPOSED FIX: ${item.proposedFix || '(none given)'}\n\nDo NOT trust the report. Independently READ the cited code and surrounding paths. Try to REFUTE it. Return CONFIRMED only if you personally verified the defect exists with your own file:line reading. Return REFUTED if the code actually handles this correctly. Classify fixScope: money-rls-auth if the fix touches money movement, RLS/tenant isolation, or auth (these are held for human review); else safe. Give the smallest correct fix.`,
    { label: `verify:${(item.title || '').slice(0, 30)}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'sonnet' },
  ).then(v => ({ ...item, ...v })).catch(() => null)
))

const confirmed = verified.filter(Boolean).filter(v => v.verdict === 'CONFIRMED' || v.verdict === 'PARTIAL')

return {
  audits,
  redteams,
  verifiedCount: verified.filter(Boolean).length,
  confirmed: confirmed.sort((a, b) => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3, none: 4 }
    return (rank[a.correctedSeverity] ?? 2) - (rank[b.correctedSeverity] ?? 2)
  }),
}
