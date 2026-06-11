"""
CaptureAgent — the voice-debrief capture agent.

Decision mapping:
  - D2 (voice debrief primary): this agent owns voice capture → structured
    events. It is the entry point for all field work.
  - D3 (trust per action class): trust_tier is "autonomous" for capture —
    a high-confidence classification of a job/customer/amount is
    committed without human review. This directly contradicts the current
    `ai/guardrails/confidence.ts` "advisory only" comment; closing that
    gap is part of the D3 flip.
  - D4 (stay in lane): system prompt is narrowly scoped to extraction +
    clarification. No volunteered advice.
  - D6 (multi-user): this agent runs under whichever user's session
    initiated the capture. Its tool set is filtered by that user's RBAC.
  - D8 (retention + memory): the memory namespace is per-tenant. This
    agent owns the extraction-quality learning slice.
  - D9 (hard gates): `mcp_tools` lists exactly the tool servers this
    agent can reach; the jobs_server exposes read-only customer and job
    lookups plus a proposal drafter, nothing money-moving.
"""

from __future__ import annotations

from agent.primitive import Agent

# System prompt — adapted from the current prompts.py CLASSIFY_EXTRACT_SYSTEM
# but tightened to match D4 ("stay in lane, no volunteered advice").
CAPTURE_SYSTEM_PROMPT = """You are the Capture Agent for Service OS, a back-office platform for
independent trades businesses (plumbing, HVAC, electrical, painting).

Your job is narrow: given a voice transcript or text from a field
technician, classify the intent and extract structured entities. You do
NOT offer business advice, suggest pricing changes, coach the operator,
or volunteer opinions. You answer what is asked and nothing more.

INTENTS:
- create_invoice
- update_status
- create_estimate
- schedule_job
- add_customer
- question
- unknown

If the intent is money-moving and the customer or amount is missing, set
clarification_needed. If you are not sure, mark intent unknown and ask
for clarification. Never hallucinate a customer, amount, or service.

Respond with ONLY valid JSON matching the extraction schema; no markdown,
no commentary.
""".strip()


CAPTURE_AGENT = Agent(
    name="capture",
    scope=(
        "Voice-debrief capture for field technicians. Classifies intent, "
        "extracts entities, resolves customers via the jobs MCP server, "
        "and drafts a proposal for the downstream invoice agent."
    ),
    system_prompt=CAPTURE_SYSTEM_PROMPT,
    memory_namespace="{tenant_id}:capture",
    mcp_tools=("jobs_server",),
    trust_tier="autonomous",
    triggers=(
        "voice_capture",
        "text_capture",
        "schedule:cron:daily_debrief",
    ),
)
