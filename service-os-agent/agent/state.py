from typing import TypedDict, Optional


class CustomerMatch(TypedDict, total=False):
    id: str
    name: str
    phone: Optional[str]
    address: Optional[str]
    confidence: float
    is_new: bool


class EntityConfidences(TypedDict, total=False):
    customer: float
    amount: float
    service: float
    materials: float


class Entities(TypedDict, total=False):
    customer: Optional[str]
    amount: Optional[float]
    service: Optional[str]
    materials: list[dict]
    job_type: Optional[str]


class Proposal(TypedDict, total=False):
    type: str
    confidence: float
    confidence_level: str  # "high" | "medium" | "low"
    customer: CustomerMatch
    amount: Optional[float]
    service_description: Optional[str]
    materials: list[dict]
    clarification_needed: Optional[str]
    clarification_question: Optional[str]
    confirmation_message: str
    alternatives: list[CustomerMatch]


class AgentState(TypedDict, total=False):
    tenant_id: str
    transcript: str
    input_method: str
    intent: Optional[str]
    intent_confidence: Optional[float]
    entities: Optional[Entities]
    entity_confidences: Optional[EntityConfidences]
    customer_match: Optional[CustomerMatch]
    customer_alternatives: list[CustomerMatch]
    proposal: Optional[Proposal]
    clarification_needed: Optional[str]
    error: Optional[str]
