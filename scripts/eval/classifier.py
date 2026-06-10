"""Rule-based bilingual (EN/ES) intent classifier + routing for ServiceOS voice.

This is a transparent baseline — ordered, weighted lexical patterns over
accent-normalized text — established as the launch floor the corpus is built
against. It is deliberately interpretable: every prediction traces to a
matched pattern, which is what makes the failure analysis in run_eval.py
actionable. A learned model would replace `classify_intent` while reusing the
same corpus, splits, and metrics.

Pipeline (production routing order):
  1. negative routing   (telemarketer/vendor/survey/employment/wrong#/kids)
  2. emergency triggers  (life-safety overrides everything)
  3. intent scoring      (highest-weighted intent, else "unknown")
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from corpus_io import normalize

# Booking intents that must NEVER fire on a negative/rejection utterance.
BOOKING_INTENTS = frozenset(
    {
        "create_appointment",
        "reschedule_appointment",
        "confirm_appointment",
        "create_job",
        "create_customer",
        "convert_lead",
        "add_service_location",
        "draft_estimate",
        "draft_invoice",
        "record_payment",
    }
)

# ── Emergency triggers (life-safety) ──────────────────────────────────────
# Sourced from corpus/data/triage-rules.json TIER_1/TIER_2 plus accent/Spanish
# spellings the ASR layer produces.
_EMERGENCY = [
    "smell gas", "smells like gas", "smell of gas", "gas leak", "huele a gas",
    "carbon monoxide", "co alarm", "co detector",
    "flooding", "flooded", "flood", "inundando", "inund",
    "water everywhere", "water all over", "agua por todos lados",
    "gushing", "pouring out", "pouring outta", "spray everywhere", "spraying out",
    "burst", "pipe burst", "exploded", "revento", "se revento",
    "sewage", "sewer backup", "sewer backing", "backing up", "regresando el drenaje",
    "basement filling", "basement fill", "filling up with water", "fillin up with water",
    "ceiling bulging", "bulging", "pourin", "pouring",
    "no heat", "freezing", "freezin", "ice cold", "no tenemos calefaccion",
    "sparks", "sparking", "burning smell", "hissing and there",
    "up to my ankles", "main line backed up", "cant find the shutoff",
    "cant shut it off", "cannot shut it off", "no puedo cerrarla",
]

# ── Negative / rejection routing ──────────────────────────────────────────
_NEGATIVE_RULES: list[tuple[str, list[str]]] = [
    (
        "route_to_careers",
        [
            "are you hiring", "you guys hiring", "any openings", "drop off my resume",
            "take apprentices", "looking for help", "needs a job", "hire helpers",
            "job application", "still hiring", "paid training program", "pay like for a service tech",
            "looking for work",
        ],
    ),
    (
        "ignore",
        # telemarketer / vendor / survey / wrong-number / kids
        "merchant processing|google business listing|complimentary marketing|first page of search|"
        "extending the warranty|working capital|verified profile|credit card processing|"
        "solar for your|commercial insurance for contractors|seo ranking|lead generation service|"
        "uniform supply|wholesale fittings|local directory|gps tracking|branded apparel|truck wraps|"
        "payroll services|buys your tools|commercial fuel cards|advertising your business|"
        "business phone system|conducting a brief survey|customer satisfaction|research call|"
        "scale of one to ten|polling small businesses|short study|automated survey|"
        "market research|quality and research purposes|research project|gathering feedback for|"
        "is this joe|trying to reach|wrong number|orthodontist|towing company|is this the vet|"
        "insurance agent|courthouse|pharmacy refill|gas company|hair salon|locksmith|"
        "mommy.{0,3}phone|poopy phone|are you a dinosaur|beep beep beep|daddy has a truck|"
        "twinkle twinkle|supposed to use the phone|gaaaa|like cookies|hewwo".split("|"),
    ),
]

# ── Intent patterns ───────────────────────────────────────────────────────
# Each intent -> list of (regex, weight). Patterns run over normalized
# (accent-stripped, lowercase, punctuation-free) text. EN + ES anchors mixed.
_INTENT_PATTERNS: dict[str, list[tuple[str, float]]] = {
    "reschedule_appointment": [
        (r"reschedul", 3), (r"move (my|the) .*appointment", 3), (r"push (my|the|it).*(appointment|back|to)", 2.5),
        (r"change (my|the) .*(appointment|cita)", 2.5), (r"bump (my|the) .*appointment", 3),
        (r"mover (la )?cita|cambiar (mi |la )?cita|reagendar|cambiar la appointment|puedo mover la cita", 3),
        (r"move it.*(later|to)|push it to", 2.5),
    ],
    "cancel_appointment": [
        (r"\bcancel\b", 3), (r"cancelar", 3), (r"dont need the tech", 2), (r"ya no necesito que venga", 2),
    ],
    "confirm_appointment": [
        (r"confirm", 3), (r"still coming|still on for|youre coming out right|still on", 2.5),
        (r"confirmar|sigue en pie|todavia vienen", 3),
    ],
    "callback": [
        (r"call me back|callback|have (a|some).*call me|call me.*later", 3),
        (r"regresar la llamada|que (me|alguien me) (llame|hablen|llame)|me pueden llamar|alguien me llame|necesito un callback", 3),
    ],
    "create_appointment": [
        (r"\bappointment\b", 1.2), (r"schedule (a |an )?(visit|appointment)", 2.5), (r"\bbook (a|an|me|an appointment)\b", 2),
        (r"send (someone|a tech|somebody|a guy|a person)", 2.5), (r"get someone out|come out and look|come look at",
         2.5), (r"how soon can you get here", 3), (r"set me up for", 2.5), (r"can you come (today|tomorrow|out)", 2),
        (r"do you have anything|come out about|need somebody to come|somebody to come out", 2.5),
        (r"hacer una cita|\bagendar\b|necesito que venga alguien|manden a alguien|mandar a alguien", 3),
        (r"necesito un plumber|me pueden agendar|pueden mandar a alguien|tienen para", 3),
    ],
    "emergency_dispatch": [
        (r"basement is flooding|water is everywhere|pipe (just )?(burst|exploded)", 3),
        (r"sotano|emergencia|se revento un tubo", 3),
    ],
    "create_customer": [
        (r"new customer|i m new|im new|first time (calling|caller)", 3), (r"set up (service|an account)", 2.5),
        (r"become a customer|get on the books|set up an account", 2.5),
        (r"cliente nuevo|soy nuevo|dar de alta|abrir una cuenta|quiero ser cliente", 3),
    ],
    "update_customer": [
        (r"update my (address|phone|email|number)", 3), (r"(my )?(phone|number|email).*(changed|new)|got a new number|new number", 2.5),
        (r"i moved.*(update|address)|change the address you have", 2.5),
        (r"actualizar mi|me cambie de casa|cambie de numero|actualizar mi correo|cambien mi direccion", 3),
        (r"numero nuevo.*misma cuenta|tengo numero nuevo", 3),
    ],
    "add_service_location": [
        (r"add (my|a|another).*(property|address|location|house)", 3), (r"second (address|location)", 2.5),
        (r"another property.*account|property i need on the account|put my shop address", 2.5),
        (r"agregar (mi|otra|la).*(propiedad|direccion|ubicacion|casa)|segunda ubicacion", 3),
        (r"otra propiedad para la cuenta|agreguen .*(casa|direccion|a mi cuenta)|propiedad de renta a (la|mi) cuenta", 3),
    ],
    "convert_lead": [
        (r"lets do it|ready to move forward|go ahead with the work|sounds good sign me up", 3),
        (r"lets book it|sign me up|go ahead and set me up|talked it over lets book", 2.5),
        (r"hagamoslo|seguir adelante|vamos con el trabajo|apunteme|vamos a agendarlo|quiero seguir adelante", 3),
    ],
    "create_job": [
        (r"open a job|need (that |it )?fixed|need work done|problem with (my|the)", 2.5),
        (r"somethings wrong with|something is wrong with|ive got a problem", 2.5),
        (r"abrir un trabajo|problema con|necesito trabajo|algo anda mal|necesito que (lo )?arreglen", 3),
    ],
    "draft_estimate": [
        (r"(send me|get|like) (a |an )?(written )?(estimate|quote)", 2.8), (r"estimate for|quote for|quote in writing", 2.5),
        (r"estimate before i commit|written quote", 2.5),
        (r"estimado para|cotizacion por escrito|presupuesto del|un estimado antes|mandenme un estimate", 3),
    ],
    "send_estimate": [
        (r"(text|email|resend|forward|send over|send) .*(estimate|quote)", 2.2), (r"resend the estimate|lost it",
         2.5), (r"text me that estimate|forward me the estimate|send over that quote", 3),
        (r"mandar el estimado|reenvian el estimado|manden esa cotizacion|envienme el estimado|mandar el estimate", 3),
    ],
    "draft_invoice": [
        (r"invoice for the (work|job)|need an invoice|send me a bill|invoice me|need a receipt|send me the invoice", 3),
        (r"factura del trabajo|factura por la reparacion|mandan la cuenta|me facturan|el invoice del trabajo", 3),
    ],
    "record_payment": [
        (r"pay (my |the )?(bill|balance|invoice)|make a payment|pay what i owe|give you a card", 3),
        (r"pagar (mi |el )?(cuenta|balance|factura)|hacer un pago|pagar lo que debo", 3),
    ],
    "log_expense": [
        (r"log .*(dollars|fittings|materials|fuel|expense|supply run)|charge the parts|put .*(bucks|dollars) of",
         3), (r"(add a|log a)? ?fuel expense|add .*expense (for|to)", 3),
        (r"apunta .*dolares|pon .*de partes|agrega gasolina|cargale las partes|registra el gasto", 3),
    ],
    "log_time_entry": [
        (r"(log|put me down for|clock me for|add) .*(hour|hours)|hours on (the|my)", 3),
        (r"apuntame .*horas|registra .*(hora|labor)|agrega .*horas|ponme .*horas|minutos.*registralo|pase como .*minutos", 3),
    ],
    "add_note": [
        (r"add a note|put a note|note that|leave a note|add a note to", 3),
        (r"pon una nota|agrega una nota|nota que|anota que", 3),
    ],
    "notify_delay": [
        (r"running .*(behind|late)|going to be late|stuck in traffic|ill be there in|minutes out|minutes behind", 3),
        (r"voy .*tarde|llegar tarde|estoy en el trafico|voy retrasado|llego en media hora", 3),
    ],
    "request_feedback": [
        (r"review request|ask .*for a review|feedback request|review link|request feedback", 3),
        (r"solicitud de resena|resena al cliente|peticion de feedback|solicita feedback|link de resena", 3),
    ],
    "mark_lead_lost": [
        (r"mark .*lead .*lost|lead .*lost|not moving forward|went with someone else|set .*lead to lost|mark it lost|decided not to do it", 3),
        (r"lead de .*perdido|cierra ese lead|marcalo .*perdido|lead como perdido", 3),
    ],
    "lookup_appointments": [
        (r"when is my (next )?appointment|what time is my appointment|anything scheduled", 3),
        (r"when .*(tech|technician) .*coming|on my schedule", 2.5),
        (r"cuando es mi (proxima )?cita|a que hora es mi cita|algo agendado|que tengo agendado|cuando viene el tecnico|me recuerda cuando", 3),
    ],
    "lookup_jobs": [
        (r"status on the job|is the work done|where are we at on|did the tech finish|update on my service", 3),
        (r"como va el trabajo|ya esta listo el trabajo|como vamos con|ya termino el tecnico|actualizacion de mi servicio", 3),
    ],
    "lookup_invoices": [
        (r"how much do i owe|my balance|open invoices|last payment go through|still owe", 3),
        (r"cuanto les debo|cual es mi balance|facturas pendientes|entro mi ultimo pago|cuanto debo todavia", 3),
    ],
    "lookup_estimates": [
        (r"estimate ever go out|price on the estimate|what the estimate covered|estimate still good|total on my estimate", 3),
        (r"ya me mandaron el estimado|precio del estimado|cubria el estimado|sirve mi estimado|total de mi estimado", 3),
    ],
    "lookup_account_summary": [
        (r"whats on my account|rundown of my account|have on file for me|summarize my account|my account look like", 3),
        (r"que hay en mi cuenta|resumen de mi cuenta|tienen registrado de mi|resume mi cuenta|como esta mi cuenta", 3),
    ],
    "lookup_customer": [
        (r"have me in the system|in your records|look me up|address on file|check if im a customer", 3),
        (r"me tienen en el sistema|en sus registros|me pueden buscar|direccion registrada|ya soy cliente", 3),
    ],
    "pricing_question": [
        (r"how much do you charge|whats it run to|how much for|ballpark .*cost|what do you charge to", 3),
        (r"cuanto cobran|cuanto sale cambiar|cuanto costaria|cuanto cobran la visita", 3),
    ],
    "hours_location": [
        (r"cover the east side|your hours|open on weekends|service my area|where are you located", 3),
        (r"servicio en el lado|cual es su horario|abren los fines|servicio en mi area|donde estan ubicados", 3),
    ],
    "service_availability": [
        (r"do you (all |guys )?(work on|do|handle)|something you guys do|commercial work or just residential|can you work on", 2.5),
        (r"trabajan con|hacen reparaciones de|ustedes hacen lo del|trabajo comercial o solo|pueden arreglar", 3),
    ],
    "complaint": [
        (r"supposed to come .*nobody showed|broken again already|waited all day and no one|left a mess|third time ive called", 3),
        (r"iba a venir .*nadie llego|ya se descompuso otra vez|espere todo el dia|dejo un tiradero|tercera vez que llamo", 3),
    ],
    "payment_dispute": [
        (r"no way it should be this much|charged me twice|doesnt match what i was quoted|never agreed to this charge|mistake on my bill", 3),
        (r"no puede ser tanto|cobraron dos veces|no coincide con lo que me cotizaron|nunca acepte este cargo|error en mi cuenta", 3),
    ],
    "dnc_optout": [
        (r"take me off your list|stop calling me|do not call|quit texting me|remove my number", 3),
        (r"quitenme de su lista|dejen de llamarme|lista de no llamar|dejen de mandarme textos|borren mi numero", 3),
    ],
    "greeting": [
        (r"hi there|hows it going|good morning|good afternoon|can you hear me okay|\bhello\b", 1.0),
        (r"como esta|buenos dias|buenas tardes|me escucha bien", 1.0), (r"\bhola\b", 0.8),
    ],
    "agent_handoff_request": [
        (r"(talk to|speak to|speak with).*(actual|real)? ?(person|human)|is there a human|transfer me to a person|put me through to someone", 3),
        (r"hablar con una persona|alguien con quien.*hablar|persona real|paseme con alguien|transferir con una persona", 3),
    ],
}


@dataclass
class Prediction:
    intent: str
    score: float
    routing: str | None = None  # set for negatives / non-proposal routing


def is_emergency(text: str) -> bool:
    n = normalize(text)
    return any(trig in n for trig in _EMERGENCY)


def route_negative(text: str) -> str | None:
    n = normalize(text)
    for routing, markers in _NEGATIVE_RULES:
        for m in markers:
            if re.search(m, n):
                return routing
    return None


def classify_intent(text: str) -> Prediction:
    """Full routing: negative -> emergency -> scored intent -> unknown."""
    routing = route_negative(text)
    if routing is not None:
        return Prediction(intent="unknown", score=0.0, routing=routing)
    if is_emergency(text):
        return Prediction(intent="emergency_dispatch", score=3.0)
    n = normalize(text)
    best_intent = "unknown"
    best_score = 0.0
    for intent, patterns in _INTENT_PATTERNS.items():
        score = 0.0
        for pat, weight in patterns:
            if re.search(pat, n):
                score += weight
        if score > best_score:
            best_score = score
            best_intent = intent
    return Prediction(intent=best_intent, score=best_score)


# ── Edge-case handler ─────────────────────────────────────────────────────
_IGNORE_MARKERS = [
    "is this joe", "trying to reach", "wrong number", "dialed the wrong", "dentist office",
    "calling the pharmacy", "is this the dmv", "animal shelter", "county clerk", "is this the school",
    "cable company", "is this not the bank",
    # butt dial / no caller intent
    "so anyway i told her", "grab the milk", "no one addressing", "did you see that",
    "keys jingling", "turn left up here", "ba ba ba", "what do you want for dinner",
    "tv audio only", "game went into overtime", "phone clearly in a pocket", "actually calling someone",
    "child babbling", "muffled", "no caller speaking", "hahaha",
]
_HUMAN_MARKERS = [
    "real person", "actual person", "actual employee", "a human", "human being", "manager",
    "supervisor", "in charge", "owner", "operator", "representative", "not talking to a robot",
    "not doing this with a machine", "im going to sue", "worst service ever",
    "want a person", "talk to ai", "how you treat me", "want a human",
]


def handle_edge(text: str) -> str:
    """Map an edge-case utterance to an expected handling bucket.

    Order: emergency (life-safety) -> ignore (no serviceable intent) ->
    route_to_human (explicit human/abuse) -> clarify (comprehensible-but-uncertain).
    """
    if is_emergency(text):
        return "emergency_dispatch"
    n = normalize(text)
    if any(m in n for m in _IGNORE_MARKERS):
        return "ignore"
    if any(m in n for m in _HUMAN_MARKERS):
        return "route_to_human"
    return "clarify"
