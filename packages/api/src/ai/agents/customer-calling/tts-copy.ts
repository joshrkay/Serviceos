/**
 * QA-2026-06-05 (VOX-02) — TTS template rendering + lightweight language
 * detection for the calling agent.
 *
 * The FSM emits tts_play side effects whose `text` is sometimes a TEMPLATE
 * KEY ('intent_confirm', 'greeting', …) with a `template` hint in the
 * payload. Nothing rendered those keys — callers literally heard
 * "intent_confirm", in every language. This module renders the template
 * keys into human copy and localizes them (en/es) based on a sticky
 * per-session language detected from the caller's own utterances.
 *
 * Scope: template keys only. The FSM's hardcoded English sentences
 * (escalation/fallback lines) pass through unchanged — full-catalog i18n is
 * a follow-up; VOX-02's contract is that a Spanish utterance gets a Spanish
 * RESPONSE, and the response to a classified utterance is the confirm
 * prompt rendered here.
 */

export type SessionLanguage = 'en' | 'es';

const ES_MARKERS = [
  'hola', 'necesito', 'quiero', 'quisiera', 'ayuda', 'por favor', 'gracias',
  'cita', 'agendar', 'programar', 'cancelar', 'cliente', 'mañana',
  'presupuesto', 'factura', 'aire acondicionado', 'no enfría', 'visita',
  'buenos días', 'buenas tardes', 'disculpe', 'cuándo', 'dónde',
];
const ES_CHARS = /[ñáéíóú¿¡]/i;

/** Deterministic, dependency-free: ≥1 accented char or ≥2 marker words → es. */
export function detectLanguage(utterance: string): SessionLanguage {
  const cleanText = ` ${utterance.toLowerCase().replace(/[.,\\/#!$%\\^&\\*;:{}=\\-_`~()!?¿¡]/g, " ").replace(/\\s+/g, " ")} `;
  if (ES_CHARS.test(cleanText)) return 'es';
  let hits = 0;
  for (const m of ES_MARKERS) {
    if (cleanText.includes(` ${m} `)) hits++;
    if (hits >= 2) return 'es';
  }
  return 'en';
}

const INTENT_LABELS: Record<SessionLanguage, Record<string, string>> = {
  en: {
    create_customer: 'add a new customer',
    create_appointment: 'schedule an appointment',
    create_booking: 'schedule an appointment',
    reschedule_appointment: 'reschedule your appointment',
    cancel_appointment: 'cancel your appointment',
    confirm_appointment: 'confirm your appointment',
    draft_estimate: 'put together an estimate',
    update_estimate: 'update your estimate',
    draft_invoice: 'prepare an invoice',
    send_invoice: 'send your invoice',
    record_payment: 'record a payment',
    add_note: 'add a note',
    create_job: 'open a new job',
    _default: 'take care of that request',
  },
  es: {
    create_customer: 'registrar un nuevo cliente',
    create_appointment: 'agendar una cita',
    create_booking: 'agendar una cita',
    reschedule_appointment: 'reprogramar su cita',
    cancel_appointment: 'cancelar su cita',
    confirm_appointment: 'confirmar su cita',
    draft_estimate: 'preparar un presupuesto',
    update_estimate: 'actualizar su presupuesto',
    draft_invoice: 'preparar una factura',
    send_invoice: 'enviar su factura',
    record_payment: 'registrar un pago',
    add_note: 'agregar una nota',
    create_job: 'abrir un nuevo trabajo',
    _default: 'atender su solicitud',
  },
};

function intentLabel(intent: string | undefined, lang: SessionLanguage): string {
  const table = INTENT_LABELS[lang];
  return (intent && table[intent]) || table._default;
}

const TEMPLATE_KEYS = new Set(['intent_confirm', 'greeting', 'confirm_intent', 'greeting_with_disclosure']);

/**
 * Render a tts_play payload into speakable copy. Template keys are expanded
 * and localized; anything else passes through unchanged.
 */

/**
 * es translations for the FSM's hardcoded sentences (exact-match). Kept
 * small and literal — anything not listed passes through in English rather
 * than risking a bad machine paraphrase.
 */
const SENTENCE_CATALOG_ES: Record<string, string> = {
  "Great, I've got that taken care of. You'll receive a confirmation shortly. Is there anything else I can help you with?":
    'Perfecto, ya quedó registrado. Recibirá una confirmación en breve. ¿Hay algo más en lo que pueda ayudarle?',
  'How can I help you today?': '¿En qué puedo ayudarle hoy?',
  'Thank you for calling. Have a great day!': '¡Gracias por llamar. Que tenga un excelente día!',
  "What's your name and the address you're calling about?":
    '¿Me puede dar su nombre y la dirección por la que llama?',
  "I'm connecting you with a team member who can assist you further.":
    'Le comunico con un miembro del equipo que podrá ayudarle.',
  'Of course — let me connect you with a person right now.':
    'Por supuesto — le comunico con una persona ahora mismo.',
  'I understand. Let me get a person on the line for you right away.':
    'Entiendo. Enseguida le paso con una persona.',
  "I'm having trouble completing that. Let me connect you with a team member.":
    'Tengo dificultades para completar eso. Le comunico con un miembro del equipo.',
  "I'm having trouble pulling up your account. Let me connect you with a team member.":
    'Tengo dificultades para acceder a su cuenta. Le comunico con un miembro del equipo.',
  // RV-142 — emergency safety script + transfer line.
  'If anyone is in immediate danger, hang up and call 911.':
    'Si alguien está en peligro inmediato, cuelgue y llame al 911.',
  "This sounds like an emergency. I'm connecting you with our on-call dispatcher immediately.":
    'Esto parece una emergencia. Le comunico de inmediato con nuestro despachador de guardia.',
};

export function renderTtsText(
  rawText: string,
  payload: Record<string, unknown>,
  lang: SessionLanguage,
): string {
  const template = typeof payload.template === 'string' ? payload.template : undefined;
  const key = template ?? (TEMPLATE_KEYS.has(rawText) ? rawText : undefined);
  if (!key) {
    // Exact-match catalog for the FSM's fixed customer-facing sentences —
    // they aren't templated, but a Spanish-language session must not flip
    // back to English mid-call for the closing/ack lines.
    if (lang === 'es') {
      const es = SENTENCE_CATALOG_ES[rawText];
      if (es) return es;
    }
    return rawText;
  }

  const intent = typeof payload.intent === 'string' ? payload.intent : undefined;
  switch (key) {
    case 'confirm_intent':
    case 'intent_confirm':
      return lang === 'es'
        ? `Para confirmar: usted desea ${intentLabel(intent, 'es')}. ¿Es correcto?`
        : `Just to confirm — you'd like to ${intentLabel(intent, 'en')}. Is that right?`;
    case 'greeting':
      return lang === 'es'
        ? '¡Hola! ¿En qué puedo ayudarle hoy?'
        : 'Hi! How can I help you today?';
    case 'greeting_with_disclosure':
      return lang === 'es'
        ? 'Hola, soy un asistente virtual. ¿En qué puedo ayudarle hoy?'
        : "Hi, I'm a virtual assistant. How can I help you today?";
    default:
      return rawText;
  }
}
