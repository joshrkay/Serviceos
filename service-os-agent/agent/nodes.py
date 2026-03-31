import json
import logging
import os
from langchain_anthropic import ChatAnthropic
from supabase import create_client, Client
from .state import AgentState, CustomerMatch, Proposal
from .prompts import CLASSIFY_EXTRACT_SYSTEM

logger = logging.getLogger(__name__)

# ─── Shared clients (initialized lazily) ────────────────────

_llm = None
_supabase: Client | None = None


def _require_env(name: str) -> str:
    """Get a required environment variable or raise a clear error."""
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return value


def get_llm() -> ChatAnthropic:
    global _llm
    if _llm is None:
        _llm = ChatAnthropic(
            model="claude-sonnet-4-20250514",
            max_tokens=500,
            anthropic_api_key=_require_env("ANTHROPIC_API_KEY"),
        )
    return _llm


def get_supabase() -> Client:
    global _supabase
    if _supabase is None:
        _supabase = create_client(
            _require_env("SUPABASE_URL"),
            _require_env("SUPABASE_SERVICE_ROLE_KEY"),
        )
    return _supabase


# ─── Node 1: Classify + Extract ─────────────────────────────

def classify_extract(state: AgentState) -> dict:
    """Single Claude call: classify intent and extract entities from transcript."""
    llm = get_llm()

    try:
        response = llm.invoke([
            {"role": "system", "content": CLASSIFY_EXTRACT_SYSTEM},
            {"role": "user", "content": state["transcript"]},
        ])

        text = response.content
        if isinstance(text, list):
            text = text[0].get("text", "") if text else ""

        # Strip markdown fences if present
        text = text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

        data = json.loads(text)

        return {
            "intent": data.get("intent", "unknown"),
            "intent_confidence": data.get("intent_confidence", 0.5),
            "entities": data.get("entities", {}),
            "entity_confidences": data.get("entity_confidences", {}),
            "clarification_needed": data.get("clarification_needed"),
        }

    except (json.JSONDecodeError, KeyError, IndexError) as e:
        logger.warning("Failed to parse LLM response: %s", e)
        return {
            "intent": "unknown",
            "intent_confidence": 0.0,
            "entities": {},
            "entity_confidences": {},
            "error": f"Parse error: {e}",
        }
    except Exception as e:
        logger.exception("Unexpected error in classify_extract")
        return {
            "intent": "unknown",
            "intent_confidence": 0.0,
            "entities": {},
            "entity_confidences": {},
            "error": str(e),
        }


# ─── Node 2: Resolve customer via Supabase fuzzy match ──────

def resolve(state: AgentState) -> dict:
    """Fuzzy-match extracted customer name against Supabase using pg_trgm."""
    entities = state.get("entities") or {}
    customer_name = entities.get("customer")

    if not customer_name:
        return {
            "customer_match": None,
            "customer_alternatives": [],
        }

    tenant_id = state.get("tenant_id", "")
    supabase = get_supabase()

    # pg_trgm similarity query
    query = supabase.rpc(
        "match_customer",
        {
            "p_tenant_id": tenant_id,
            "p_name": customer_name,
            "p_threshold": 0.3,
            "p_limit": 5,
        },
    ).execute()

    matches = query.data or []

    if not matches:
        # No match — treat as new customer
        return {
            "customer_match": CustomerMatch(
                id="",
                name=customer_name,
                confidence=0.0,
                is_new=True,
            ),
            "customer_alternatives": [],
        }

    # Apply confidence scoring
    scored: list[CustomerMatch] = []
    for m in matches:
        sim = m.get("sim_score", 0)
        if sim >= 0.95:
            conf = 0.99
        elif sim >= 0.80:
            conf = 0.90
        elif sim >= 0.60:
            conf = 0.80
        else:
            conf = sim * 0.9

        scored.append(
            CustomerMatch(
                id=m["id"],
                name=m["name"],
                phone=m.get("phone"),
                address=m.get("address"),
                confidence=round(conf, 2),
                is_new=False,
            )
        )

    # Decision logic
    if len(scored) == 1 and scored[0].get("confidence", 0) >= 0.70:
        return {"customer_match": scored[0], "customer_alternatives": []}

    if len(scored) >= 2:
        # Multiple matches — check if top is clearly better
        top_conf = scored[0].get("confidence", 0)
        second_conf = scored[1].get("confidence", 0)
        if top_conf > 0.90 and top_conf - second_conf > 0.15:
            return {"customer_match": scored[0], "customer_alternatives": scored[1:]}
        return {
            "customer_match": scored[0],
            "customer_alternatives": scored,
            "clarification_needed": "customer",
        }

    # Low confidence single match
    return {"customer_match": scored[0], "customer_alternatives": []}


# ─── Node 3: Score confidence + build proposal ──────────────

def score(state: AgentState) -> dict:
    """Pure logic: score overall confidence and build the proposal dict."""
    intent = state.get("intent", "unknown")
    entities = state.get("entities") or {}
    entity_confs = state.get("entity_confidences") or {}
    customer_match = state.get("customer_match")
    clarification = state.get("clarification_needed")
    alternatives = state.get("customer_alternatives") or []

    # Gather individual confidences
    confs = [state.get("intent_confidence", 0.5)]
    if customer_match:
        confs.append(customer_match.get("confidence", 0.0))
    if entity_confs.get("amount"):
        confs.append(entity_confs["amount"])
    if entity_confs.get("service"):
        confs.append(entity_confs["service"])

    overall = min(confs) if confs else 0.0

    # Bucket
    if overall >= 0.90:
        level = "high"
    elif overall >= 0.70:
        level = "medium"
    else:
        level = "low"

    # Build confirmation message
    cust_name = (customer_match.get("name") if customer_match else None) or "unknown customer"
    amount = entities.get("amount")
    service = entities.get("service", "")
    cust_address = customer_match.get("address", "") if customer_match else ""

    if clarification == "amount":
        confirmation = f"How much should I charge {cust_name}?"
        clarification_q = confirmation
    elif clarification == "customer":
        names = [a.get("name", "?") for a in alternatives[:3]]
        confirmation = f"Which customer: {' or '.join(names)}?"
        clarification_q = confirmation
    elif level == "high":
        base = f"Invoice for {cust_name}"
        if amount:
            base += f", ${amount:,.2f}"
        if service:
            base += f", {service}"
        confirmation = f"{base} Sound good?"
        clarification_q = None
    elif level == "medium":
        addr_part = f" on {cust_address.split(',')[0]}" if cust_address else ""
        base = f"{cust_name}{addr_part}"
        if intent == "create_invoice" and amount:
            base = f"{cust_name}{addr_part} — invoice for ${amount:,.2f}"
        parts = [base]
        if service:
            parts.append(service)
        parts.append("Is that right?")
        confirmation = ", ".join(parts) if len(parts) > 2 else " — ".join(parts)
        clarification_q = None
    else:
        confirmation = f"I heard: \"{state.get('transcript', '')}\". Can you clarify?"
        clarification_q = confirmation

    proposal = Proposal(
        type=intent,
        confidence=round(overall, 2),
        confidence_level=level,
        customer=customer_match or CustomerMatch(name=cust_name, confidence=0.0, is_new=True, id=""),
        amount=amount,
        service_description=service or None,
        materials=entities.get("materials", []),
        clarification_needed=clarification,
        clarification_question=clarification_q,
        confirmation_message=confirmation,
        alternatives=alternatives if clarification == "customer" else [],
    )

    return {"proposal": proposal}
