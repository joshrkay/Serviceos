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

import { intentReadbackPhrase } from './intent-readback';
import { OUT_OF_SERVICE_AREA_COPY, SERVICE_AREA_ZIP_QUESTION } from '../../voice-turn/service-area-gate';
import { bookingAwaitsTime } from './confirm-turn';
import { EMERGENCY_SAFETY_LINE } from './emergency-detector';
import { en as I18N_EN } from '../../i18n/en';
import { es as I18N_ES } from '../../i18n/es';

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

/**
 * Human-readable noun for an entity kind, used by the `entity_confirm`
 * readback ("I found a job 'HVAC Repair' — is that the one you mean?").
 */
const ENTITY_KIND_LABELS: Record<SessionLanguage, Record<string, string>> = {
  en: {
    customer: 'customer',
    job: 'job',
    invoice: 'invoice',
    estimate: 'estimate',
    appointment: 'appointment',
    technician: 'technician',
    pending_proposal: 'record',
    _default: 'record',
  },
  es: {
    customer: 'cliente',
    job: 'trabajo',
    invoice: 'factura',
    estimate: 'presupuesto',
    appointment: 'cita',
    technician: 'técnico',
    pending_proposal: 'registro',
    _default: 'registro',
  },
};

/** Indefinite article for the es entity-kind nouns above ("un cliente", "una factura"). */
const ENTITY_KIND_ARTICLE_ES: Record<string, string> = {
  invoice: 'una',
  estimate: 'un',
  appointment: 'una',
  _default: 'un',
};

function entityKindLabel(entityKind: string | undefined, lang: SessionLanguage): string {
  const table = ENTITY_KIND_LABELS[lang];
  return (entityKind && table[entityKind]) || table._default;
}

function entityKindArticleEs(entityKind: string | undefined): string {
  return (entityKind && ENTITY_KIND_ARTICLE_ES[entityKind]) || ENTITY_KIND_ARTICLE_ES._default;
}

const TEMPLATE_KEYS = new Set(['intent_confirm', 'greeting', 'confirm_intent', 'greeting_with_disclosure']);

/**
 * Render a tts_play payload into speakable copy. Template keys are expanded
 * and localized; anything else passes through unchanged.
 */


// ─── #1601 step 1 — the ONE spoken-copy source ────────────────────────────────
//
// Every fixed line a voice surface speaks lives here, keyed by id, with its
// English and Spanish side by side. Before #1601 the English sat inline in the
// turn processor, the Gather adapter, the in-app adapter, the FSM transition
// table and the quote read-back, and Spanish was keyed on the exact English
// sentence — so a one-word English edit silently dropped the Spanish, and the
// same line drifted between files (the 2026-10-04 code-health review).
//
// Rules:
//   - `{{var}}` placeholders (the `ai/i18n` syntax) for dynamic parts;
//     `ttsCopy(id, lang, vars)` interpolates them. A parameterised entry cannot
//     be looked up by its English sentence, so its call site renders by id.
//   - The FSM (transitions.ts) keeps emitting the ENGLISH sentence as
//     `payload.text` (`ttsPlay(TTS_COPY.x.en)`): transcripts, `lastSpoken`
//     comparisons and the graders see the same payload they always did, and an
//     id can never reach a caller un-rendered. The transports localize at
//     speak time through `renderTtsText`, which resolves the English sentence
//     back to its entry (`EN_SENTENCE_TO_ID`).
//   - Entries whose Spanish was written for #1601 (no shipped translation
//     existed) carry `// es: new 1601` for review. Lines that already had a
//     named constant keep it below as an alias, so existing imports are
//     unchanged.
//   - Sentences the `ai/i18n` catalog already holds are REFERENCED, not
//     retyped, so the two catalogs cannot drift until they are merged
//     (#1601 step 2/6).
//
// The rationale comments for the previously named lines (VOX-35c, A3, U5,
// RV-071, #1272, #1497, #1331, #1600 …) stay on their alias constants below.

export interface TtsCopyEntry {
  readonly en: string;
  readonly es: string;
}

export const TTS_COPY = {
  // ── named before #1601 (aliases below keep the old import names) ─────────
  speech_turn_failure_reprompt: {
    en: 'My apologies — let me try again. What would you like to do?',
    es: 'Mis disculpas — intentemos de nuevo. ¿Qué le gustaría hacer?',
  },
  turn_hold: {
    en: "Sorry for the wait — I'm still working on that.",
    es: 'Disculpe la espera — sigo trabajando en eso.',
  },
  speech_turn_failure_escalation: {
    en: "I'm having trouble completing that. Let me connect you with a team member.",
    es: 'Tengo dificultades para completar eso. Le comunico con un miembro del equipo.',
  },
  low_stt_confidence_reprompt: {
    en: "I didn't quite catch that — could you say that again?",
    es: 'No alcancé a escuchar bien eso — ¿podría repetirlo, por favor?',
  },
  max_call_duration_wrap_up: {
    en: "We're almost out of time for this call, so I'll need to wrap up now. If you need anything else, please call back and we'll pick up where we left off.",
    es: 'Estamos por llegar al límite de tiempo de esta llamada, así que tendré que terminar ahora. Si necesita algo más, por favor llame de nuevo y continuaremos donde lo dejamos.',
  },
  voice_approval_refusal: {
    en: "Tap the card to approve — I don't take approvals by voice here yet.",
    es: 'Toque la tarjeta para aprobar — aquí todavía no acepto aprobaciones por voz.',
  },
  inapp_incomplete_draft: {
    en: "I've drafted that, but it still needs a few details before it can be approved — open the card to fill them in. Is there anything else I can help you with?",
    es: 'Lo dejé como borrador, pero le faltan algunos datos antes de poder aprobarlo — abra la tarjeta para completarlos. ¿Hay algo más en lo que pueda ayudarle?',
  },
  operator_drafted_for_review: {
    en: "I've drafted that — it's in your approvals waiting for you to review. Is there anything else I can help you with?",
    es: 'Lo dejé como borrador — está en sus aprobaciones esperando su revisión. ¿Hay algo más en lo que pueda ayudarle?',
  },
  which_appointment_reschedule: {
    en: "Which appointment would you like to reschedule? You can tell me the customer's name.",
    es: '¿Qué cita quiere reprogramar? Puede decirme el nombre del cliente.',
  },
  which_appointment_cancel: {
    en: "Which appointment would you like to cancel? You can tell me the customer's name.",
    es: '¿Qué cita quiere cancelar? Puede decirme el nombre del cliente.',
  },
  which_appointment_default: {
    en: "Which appointment is this about? You can tell me the customer's name.",
    es: '¿De qué cita se trata? Puede decirme el nombre del cliente.',
  },
  caller_request_queued: {
    en: "I've passed that along to our team, and someone will confirm it with you shortly. Is there anything else I can help you with?",
    es: 'Ya le pasé su solicitud a nuestro equipo, y alguien se la confirmará en breve. ¿Hay algo más en lo que pueda ayudarle?',
  },
  caller_incomplete_request: {
    en: "I've passed that along, but a few details still need to be sorted out before it's final — someone from our team will follow up with you. Is there anything else I can help you with?",
    es: 'Ya pasé su solicitud, pero faltan algunos detalles antes de que quede lista — alguien de nuestro equipo se comunicará con usted. ¿Hay algo más en lo que pueda ayudarle?',
  },
  cross_customer_refusal: {
    en: 'I can only help with the account on this line.',
    es: 'Solo puedo ayudarle con la cuenta de esta línea.',
  },
  repeated_request_handoff: {
    en: 'I want to make sure this gets handled properly — let me get a person to help you with it.',
    es: 'Quiero asegurarme de que esto se atienda bien — déjeme comunicarle con una persona que pueda ayudarle.',
  },
  rebook_declined: {
    en: 'No problem. Is there anything else I can help you with?',
    es: 'No hay problema. ¿Hay algo más en lo que pueda ayudarle?',
  },
  // #1567 — the service-area gate's two lines; English owned by
  // voice-turn/service-area-gate.ts (outside step 1's files), Spanish here.
  out_of_service_area: {
    en: OUT_OF_SERVICE_AREA_COPY,
    es: 'Normalmente no damos servicio en esa zona, pero le pasaré sus datos al equipo.',
  },
  service_area_zip_question: {
    en: SERVICE_AREA_ZIP_QUESTION,
    es: 'Claro — ¿cuál es el código postal de la dirección donde necesita el servicio?',
  },
  // RV-142 — the 911 line; English owned by emergency-detector.ts.
  emergency_safety_line: {
    en: EMERGENCY_SAFETY_LINE,
    es: 'Si alguien está en peligro inmediato, cuelgue y llame al 911.',
  },
  // UB-C1 / #846 — language-switch lines. NOT translations of each other:
  // each is spoken in the language the call is in (or switching to), so they
  // are kept out of the English→Spanish reverse index.
  language_switch_ack: {
    en: "Okay, let's continue in English. How can I help you?",
    es: 'De acuerdo, continuemos en español. ¿En qué puedo ayudarle?',
  },
  language_unsupported: {
    en: "I'm sorry — I can only help in English on this line. What can I help you with?",
    es: 'Lo siento — en esta línea solo puedo ayudarle en español. ¿En qué puedo ayudarle?',
  },
  language_switch_cap: {
    en: "Let's keep going in English so I don't lose you — what can I help you with?",
    es: 'Sigamos en español para no perderle — ¿en qué puedo ayudarle?',
  },
  // Template renders that used to be inline in renderTtsText.
  greeting_plain: {
    en: 'Hi! How can I help you today?',
    es: '¡Hola! ¿En qué puedo ayudarle hoy?',
  },
  greeting_with_disclosure: {
    en: "Hi, I'm a virtual assistant. How can I help you today?",
    es: 'Hola, soy un asistente virtual. ¿En qué puedo ayudarle hoy?',
  },
  // #1577 — a booking with no day or time asks for one before any readback.
  booking_awaits_time: {
    en: 'What date and time work for you?',
    es: '¿Qué fecha y hora le convienen?',
  },
  // VOX-52 — the "two Bobs" branch of the disambiguation prompt.
  disambiguation_same_name: {
    en: 'I found more than one record under that name. Could you give me the service address so I can pick the right one?',
    es: 'Encontré más de un registro con ese nombre. ¿Me puede dar la dirección de servicio para elegir el correcto?',
  },

  // ── transitions.ts (the FSM) ─────────────────────────────────────────────
  entity_not_found_escalation: {
    en: "I wasn't able to find the record you're referring to. Let me connect you with a team member.",
    es: 'No pude encontrar el registro al que se refiere. Le comunico con un miembro del equipo.',
  },
  abuse_terminated: {
    en: 'This call has been terminated due to policy violations.',
    es: 'Esta llamada ha sido terminada por violaciones a nuestras políticas.',
  },
  account_lookup_failed_escalation: {
    en: "I'm having trouble pulling up your account. Let me connect you with a team member.",
    es: 'Tengo dificultades para acceder a su cuenta. Le comunico con un miembro del equipo.',
  },
  escalation_transfer: {
    en: "I'm connecting you with a team member who can assist you further.",
    es: 'Le comunico con un miembro del equipo que podrá ayudarle.',
  },
  scheduling_help_redirect: {
    en: 'I can help with scheduling and service questions. What do you need help with today?',
    es: 'Puedo ayudarle con citas y preguntas de servicio. ¿En qué necesita ayuda hoy?',
  },
  operator_request_transfer: {
    en: 'Of course — let me connect you with a person right now.',
    es: 'Por supuesto — le comunico con una persona ahora mismo.',
  },
  emergency_dispatch_transfer: {
    en: "This sounds like an emergency. I'm connecting you with our on-call dispatcher immediately.",
    es: 'Esto parece una emergencia. Le comunico de inmediato con nuestro despachador de guardia.',
  },
  frustration_transfer: {
    en: 'I understand. Let me get a person on the line for you right away.',
    es: 'Entiendo. Enseguida le paso con una persona.',
  },
  // Also the processor's ASK_CALLER_HELP_PROMPT and the Gather greeting's CTA
  // (ai/i18n `greeting.cta`) — one sentence, referenced from i18n.
  how_can_i_help: {
    en: I18N_EN['greeting.cta'],
    es: I18N_ES['greeting.cta'],
  },
  ask_caller_name_address: {
    en: "What's your name and the address you're calling about?",
    es: '¿Me puede dar su nombre y la dirección por la que llama?',
  },
  identity_verification_failed_escalation: {
    en: "I'm having trouble verifying your identity. Let me connect you with a team member.",
    es: 'Tengo dificultades para verificar su identidad. Le comunico con un miembro del equipo.',
  },
  account_not_found_ask_details: {
    en: "I'm sorry, I couldn't find your account. Can you please provide your full name and service address?",
    es: 'Lo siento, no pude encontrar su cuenta. ¿Me puede dar su nombre completo y la dirección de servicio?',
  },
  still_trouble_understanding_reprompt: {
    en: "I'm still having trouble understanding. Could you describe what you need in a few words?",
    es: 'Sigo teniendo dificultades para entenderle. ¿Podría describir en pocas palabras lo que necesita?',
  },
  understanding_failed_escalation: {
    en: "I'm having trouble understanding your request. Let me connect you with a team member.",
    es: 'Tengo dificultades para entender su solicitud. Le comunico con un miembro del equipo.',
  },
  clarify_intent_reprompt: {
    en: 'Let me make sure I understand — what would you like to do?',
    es: 'Permítame asegurarme de entender — ¿qué le gustaría hacer?',
  },
  // The pre-WS5 fixed confirmation (also quote-readback's
  // GENERIC_PROPOSAL_CONFIRMATION): spoken only for a proposal that executed.
  generic_proposal_confirmation: {
    en: "Great, I've got that taken care of. You'll receive a confirmation shortly. Is there anything else I can help you with?",
    es: 'Perfecto, ya quedó registrado. Recibirá una confirmación en breve. ¿Hay algo más en lo que pueda ayudarle?',
  },
  goodbye_thanks: {
    en: 'Thank you for calling. Have a great day!',
    es: '¡Gracias por llamar. Que tenga un excelente día!',
  },
  anything_else_of_course: {
    en: 'Of course! What else can I help you with?',
    es: '¡Por supuesto! ¿En qué más puedo ayudarle?',
  },
  // WS18 — refinement cap: the agent stops editing the live quote and hands it
  // to the owner. Deliberately makes NO booking claim.
  refinement_cap: {
    en: 'Let me have the owner finalize the details and send you the full quote by text.',
    es: 'Permítame que el propietario finalice los detalles y le envíe el presupuesto completo por mensaje de texto.', // es: new 1601
  },
  // WS18 — bounded reprompt in `closing` on a low-confidence reply to a quote.
  post_quote_reprompt: {
    en: 'Sorry — did you want me to lock that in, or is there something to change?',
    es: 'Disculpe — ¿quiere que lo deje confirmado, o hay algo que cambiar?', // es: new 1601
  },
  // N-003 (P2-036) — holding line when the caller pushes on price/scope/terms;
  // the agent never negotiates. The processor may swap it for the brand-voiced
  // composer (`source: 'negotiation_holding'`).
  negotiation_holding: {
    en: "That's a good question — I'll need to check with the owner on that, and we'll get right back to you. Is there anything else I can help with in the meantime?",
    es: 'Es una buena pregunta — tendré que consultarlo con el propietario y le responderemos enseguida. ¿Hay algo más en lo que pueda ayudarle mientras tanto?', // es: new 1601
  },
  // #846 / D-027 — complaint acknowledgment; the agent never argues or
  // promises a remedy, it hands the caller to a human.
  complaint_escalation: {
    en: "I'm sorry to hear that — let me get a person on the line to help you right away.",
    es: 'Lamento escuchar eso — enseguida le paso con una persona para que le ayude.', // es: new 1601
  },
  // #846 — a bare "yes" with nothing pending to confirm.
  confirm_nothing_pending: {
    en: "I don't have anything waiting on a yes from you just yet — what would you like to do?",
    es: 'Por ahora no tengo nada pendiente de su confirmación — ¿qué le gustaría hacer?', // es: new 1601
  },
  // #1406 D10 — a farewell is a clean close.
  farewell_close: {
    en: 'Okay — talk soon. Goodbye!',
    es: 'De acuerdo — hasta pronto. ¡Adiós!', // es: new 1601
  },
  technical_issue_escalation: {
    en: "One moment — I'm having a brief technical issue. Let me connect you with a team member.",
    es: 'Un momento — tengo un breve problema técnico. Le comunico con un miembro del equipo.', // es: new 1601
  },
  caller_id_mismatch_reask: {
    en: 'Sorry about that. Who am I speaking with, and how can I help you today?',
    es: 'Disculpe. ¿Con quién hablo, y en qué puedo ayudarle hoy?', // es: new 1601
  },
  confirm_repeat_reprompt: {
    en: 'I want to make sure I got that right — can you say that again?',
    es: 'Quiero asegurarme de haberlo entendido bien — ¿podría repetirlo?', // es: new 1601
  },

  // ── ai/voice-turn/create-voice-turn-processor.ts ─────────────────────────
  // WS2/WS18 close flow — every line below stages the quote for OWNER
  // approval and makes NO booking claim; nothing is confirmed until the owner
  // taps approve.
  post_quote_affirmative_interim: {
    en: "Perfect — I'll have the owner finalize that and send you the full quote and booking link by text.",
    es: 'Perfecto — haré que el propietario lo finalice y le envíe el presupuesto completo y el enlace de reserva por mensaje de texto.', // es: new 1601
  },
  // WS18c — asks for SMS consent before texting the quote + booking link; the
  // caller's next turn is the answer, evaluated by strict confirmIntent.
  sms_consent_ask: {
    en: "Great — I can text the full quote and a link to lock in your booking. Is it okay to send that to the number you're calling from?",
    es: 'Muy bien — puedo enviarle por mensaje de texto el presupuesto completo y un enlace para confirmar su reserva. ¿Le parece bien que lo envíe al número desde el que llama?', // es: new 1601
  },
  sms_consent_grant_ack: {
    en: "Perfect — you'll get that text shortly.",
    es: 'Perfecto — recibirá ese mensaje de texto en breve.', // es: new 1601
  },
  // WS18 — decline / ambiguous → the owner sends it. Design-exact copy.
  sms_consent_decline_fallback: {
    en: "No problem — I'll have the owner send that over, and you'll get a text shortly.",
    es: 'No hay problema — haré que el propietario se lo envíe, y recibirá un mensaje de texto en breve.', // es: new 1601
  },
  close_fallback: {
    en: "Great — I'll have the owner confirm your booking, and you'll get the quote by text shortly.",
    es: 'Muy bien — haré que el propietario confirme su reserva, y recibirá el presupuesto por mensaje de texto en breve.', // es: new 1601
  },
  // #1476 — a question at the readback the agent cannot answer from the
  // pending request or a lookup (processor + in-app adapter).
  no_detail_yet: {
    en: "I don't have that detail on this one yet.",
    es: 'Todavía no tengo ese dato para esta solicitud.', // es: new 1601
  },
  // #1485 — a draft persisted with nameable executability gaps; `{{ask}}` is
  // the gap question (`askForExecutabilityGaps`).
  drafted_with_gaps: {
    en: "I've drafted that. {{ask}}",
    es: 'Lo dejé como borrador. {{ask}}', // es: new 1601
  },
  // escalateToHuman with an empty on-call rotation: the TwiML <Say> before
  // <Hangup/>. Same sentence as ai/i18n `escalate.no_dispatcher`.
  voicemail_no_one_available: {
    en: I18N_EN['escalate.no_dispatcher'],
    es: I18N_ES['escalate.no_dispatcher'],
  },
  // D-033 find-or-create sign-up (processor + Gather adapter).
  signup_ask_name: {
    en: 'Of course — could I get your name to get you set up?',
    es: 'Por supuesto — ¿me puede dar su nombre para registrarle?', // es: new 1601
  },
  signup_ask_callback: {
    en: "I'm sorry, I couldn't see your number. What's the best phone number to reach you on?",
    es: 'Lo siento, no pude ver su número. ¿Cuál es el mejor número de teléfono para comunicarnos con usted?', // es: new 1601
  },
  signup_persist_failed: {
    en: "I'm having trouble saving that. Let me get a person to help you finish signing up.",
    es: 'Tengo dificultades para guardar eso. Le paso con una persona para que le ayude a terminar el registro.', // es: new 1601
  },
  // Unknown / stale session fallback (processor + Gather adapter).
  session_ended_call_again: {
    en: "I'm sorry, your session has ended. Please call again.",
    es: 'Lo siento, su sesión ha terminado. Por favor, llame de nuevo.', // es: new 1601
  },
  // Spoken after a lookup / en_route / cross-customer refusal answer.
  anything_else: {
    en: 'Anything else I can help you with?',
    es: '¿Hay algo más en lo que pueda ayudarle?', // es: new 1601
  },

  // ── telephony/twilio-adapter.ts ──────────────────────────────────────────
  // Divergence #10 — canned greeting when the WS `start` names a CallSid the
  // store no longer knows. Composed from the i18n greeting pieces.
  missing_session_greeting: {
    en: `${I18N_EN['greeting.opener_default']} ${I18N_EN['greeting.cta']}`,
    es: `${I18N_ES['greeting.opener_default']} ${I18N_ES['greeting.cta']}`,
  },

  // ── ai/agents/customer-calling/inapp-adapter.ts ──────────────────────────
  inapp_default_greeting: {
    en: 'Hi, this is your assistant. How can I help today?',
    es: 'Hola, soy su asistente. ¿En qué puedo ayudarle hoy?', // es: new 1601
  },
  inapp_named_greeting: {
    en: "Hi, I'm {{agent}}. How can I help today?",
    es: 'Hola, soy {{agent}}. ¿En qué puedo ayudarle hoy?', // es: new 1601
  },
  // R2 — a turn that carried no request at all.
  noise_reprompt: {
    en: "I didn't catch that — what would you like to do?",
    es: 'No alcancé a escuchar eso — ¿qué le gustaría hacer?', // es: new 1601
  },

  // ── ai/voice-turn/quote-readback.ts (WS5 / WS17) ─────────────────────────
  // The builder is English-only today (no language reaches it), so the Spanish
  // is catalogued but unreachable until the read-back takes a session language.
  uncatalogued_quote_readback: {
    en: "I've got the details — the owner will confirm pricing and you'll get the full quote by text.",
    es: 'Ya tengo los detalles — el propietario confirmará el precio y recibirá el presupuesto completo por mensaje de texto.', // es: new 1601
  },
  quote_readback_single: {
    en: "For the {{description}}, that's typically {{price}}. I'll send the full quote to confirm.",
    es: 'Para {{description}}, normalmente son {{price}}. Le enviaré el presupuesto completo para confirmarlo.', // es: new 1601
  },
  quote_readback_lines_total: {
    en: "{{lines}} — that's {{total}} all together. I'll send the full quote to confirm.",
    es: '{{lines}} — en total son {{total}}. Le enviaré el presupuesto completo para confirmarlo.', // es: new 1601
  },
  quote_readback_total_only: {
    en: "That usually comes to about {{total}} all together. I'll send the full quote to confirm.",
    es: 'Normalmente suma unos {{total}} en total. Le enviaré el presupuesto completo para confirmarlo.', // es: new 1601
  },
} as const satisfies Record<string, TtsCopyEntry>;

export type TtsCopyId = keyof typeof TTS_COPY;

export const TTS_COPY_IDS = Object.keys(TTS_COPY) as readonly TtsCopyId[];

export function isTtsCopyId(value: string): value is TtsCopyId {
  return Object.prototype.hasOwnProperty.call(TTS_COPY, value);
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function hasPlaceholders(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text);
}

/**
 * Render a catalog entry in the session language, interpolating `{{var}}`
 * placeholders from `vars` (numbers coerced with `String()`; a missing var
 * renders empty rather than leaking its placeholder — the same contract as
 * `ai/i18n`'s `t()`).
 */
export function ttsCopy(
  id: TtsCopyId,
  lang: SessionLanguage,
  vars?: Record<string, unknown>,
): string {
  const text: string = TTS_COPY[id][lang];
  if (!vars) return text;
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

/**
 * Language-pair entries that are NOT translations of one sentence: each side
 * is spoken in the language the call is in (or switching to). Resolving their
 * English through the reverse index would be wrong, so they are excluded.
 */
const NOT_REVERSE_INDEXED: ReadonlySet<TtsCopyId> = new Set<TtsCopyId>([
  'language_switch_ack',
  'language_unsupported',
  'language_switch_cap',
]);

/**
 * English sentence → id, for every fixed (non-parameterised) entry. This is
 * the FSM path: transitions.ts emits the English sentence as `payload.text`
 * and the transports resolve it here at speak time.
 */
const EN_SENTENCE_TO_ID: ReadonlyMap<string, TtsCopyId> = new Map(
  TTS_COPY_IDS.filter(
    (id) => !NOT_REVERSE_INDEXED.has(id) && !hasPlaceholders(TTS_COPY[id].en),
  ).map((id) => [TTS_COPY[id].en, id] as const),
);

/** The id whose English sentence this is, if any (fixed entries only). */
export function ttsCopyIdForSentence(sentence: string): TtsCopyId | undefined {
  return EN_SENTENCE_TO_ID.get(sentence);
}

/**
 * VOX-35c — spoken copy for the media-stream/Gather adapters' speechTurn-
 * failure recovery. The reprompt is spoken after a single transient
 * speechTurn failure (apology + reprompt instead of dead air); the hand-off
 * line is spoken before a graceful end after repeated failures. Both are
 * lines the FSM already emits (a retry reprompt and its system-failure
 * escalation), so they are NOT new copy — they are named here, and used as
 * the exact-match keys in the es catalog below, so the English and Spanish
 * forms can never drift.
 */
export const SPEECH_TURN_FAILURE_REPROMPT_COPY = TTS_COPY.speech_turn_failure_reprompt.en;
/**
 * #1331 — spoken when a phone turn is still working (LLM / lookup leg) at the
 * media-streams hold deadline, so the caller is told the truth instead of
 * sitting in silence past the 7 s no-hang floor. Not a filler: it is a status
 * line, spoken once per slow turn; the real reply still follows.
 */
export const TURN_HOLD_COPY = TTS_COPY.turn_hold.en;
export const SPEECH_TURN_FAILURE_ESCALATION_COPY = TTS_COPY.speech_turn_failure_escalation.en;

/**
 * A3 — spoken when a FINAL transcript's STT acoustic confidence (Deepgram
 * `confidence` on media-streams; Twilio Gather `Confidence`) comes back
 * below the configured floor. Distinct from
 * {@link SPEECH_TURN_FAILURE_REPROMPT_COPY} on purpose: that line covers the
 * turn PIPELINE throwing (something broke); this one covers the STT ENGINE
 * itself flagging the audio as likely mis-heard (nothing broke — the words
 * probably weren't the ones acted on). Acting on a misheard transcript risks
 * the wrong intent (e.g. "cancel" heard from "confirm"), so the caller is
 * asked to repeat rather than having the turn dispatched. The repeated-low-
 * confidence hand-off reuses {@link SPEECH_TURN_FAILURE_ESCALATION_COPY} —
 * "trouble completing that" reads naturally for "I can't reliably hear you"
 * too, and keeping one escalation line avoids a second string to translate
 * and keep in sync.
 */
export const LOW_STT_CONFIDENCE_REPROMPT_COPY = TTS_COPY.low_stt_confidence_reprompt.en;

/**
 * U5 — spoken when a call reaches the absolute per-call duration cap
 * (`VOICE_MAX_CALL_DURATION_MS`). Media streams speak it 30 s before the
 * limit and then end the leg at the limit; Gather speaks it on the first
 * turn that arrives past the limit, immediately before `<Hangup/>`. One
 * line serves both transports so they can never drift; it is the
 * the `max_call_duration_wrap_up` entry of {@link TTS_COPY} (EN + ES).
 */
export const MAX_CALL_DURATION_WRAP_UP_COPY = TTS_COPY.max_call_duration_wrap_up.en;

/**
 * RV-071 / RV-225 — spoken when a proposal approve/reject/edit is asked for
 * by VOICE on an in-app session.
 *
 * D-025 permits owner voice approval, but scopes it to "a human owner on a
 * transport-identified owner line": the RV-070 caller-ID identity is what
 * authorises it, and the money-class spoken challenge
 * (`proposal-approval-task.ts`) is the control that makes a *phone* approval
 * safe. An in-app session has neither — and needs neither, because the
 * operator is already authenticated in an app that shows the proposal card
 * with a tap-to-approve button. Porting the spoken PIN dialogue to a surface
 * that already has a screen would add a re-spoken static secret (the exposure
 * D-025's own constraint flags under #850) to buy nothing.
 *
 * So in-app voice POINTS AT THE CARD instead. This is the same posture — and
 * deliberately the same sentence, so the two surfaces can never drift — that
 * the assistant-chat route already takes for a voice-mode turn (UB-B3,
 * `routes/assistant.ts`, which re-exports this constant). The refusal is
 * honest in the strict sense the honesty guard demands: it states that
 * nothing was approved, and names the one action that does work.
 */
export const VOICE_APPROVAL_REFUSAL = TTS_COPY.voice_approval_refusal.en;

/**
 * #1272 — closing line for a proposal that was persisted WITH unfilled
 * `missingFields` (approve refuses it until someone fills them). The generic
 * "Great, I've got that taken care of. You'll receive a confirmation
 * shortly." claimed completion for exactly these drafts (QA rows SCH-03 /
 * VOX-05). These state only what is true: a draft exists and still needs
 * details — no confirmation is promised.
 *
 * In-app: the speaker is the authenticated operator who owns the card. Also
 * spoken on the OWNER phone line (#1331) — the owner owns the card too; only
 * an S1 caller hears {@link CALLER_INCOMPLETE_REQUEST_COPY}.
 */
export const INAPP_INCOMPLETE_DRAFT_COPY = TTS_COPY.inapp_incomplete_draft.en;

/**
 * #1497 — closing line for an OPERATOR (in-app, or the owner on the phone
 * line) whose confirmed request was persisted as a card still waiting on
 * their approval (`draft` / `ready_for_review`). The FSM's default "Great,
 * I've got that taken care of. You'll receive a confirmation shortly." is
 * customer-caller copy: to the operator it claims work that has not run and
 * promises a confirmation nobody sends. Only a proposal that has actually
 * executed may be announced as done.
 */
export const OPERATOR_DRAFTED_FOR_REVIEW_COPY = TTS_COPY.operator_drafted_for_review.en;

/**
 * #1272 — phone (S1/owner line) twin of {@link INAPP_INCOMPLETE_DRAFT_COPY}.
 * The caller cannot fill the card, so the honest next step is a person
 * following up — never a promised confirmation.
 */
/**
 * #1015 row 3.10 — the ONE question asked when a move/cancel names no
 * appointment ("I need to cancel my appointment"). The answer is resolved
 * through the entity resolver; nothing is read back until it is.
 */
export const WHICH_APPOINTMENT_COPY = {
  reschedule_appointment: TTS_COPY.which_appointment_reschedule.en,
  cancel_appointment: TTS_COPY.which_appointment_cancel.en,
  default: TTS_COPY.which_appointment_default.en,
} as const;

/**
 * #1331 — closing line for an S1 CALLER whose confirmed request was
 * persisted as a card waiting on the team's approval (`draft` /
 * `ready_for_review`). The FSM's default "Great, I've got that taken care
 * of. You'll receive a confirmation shortly." claims the change already
 * happened; nothing runs until a person approves it. The caller hears what
 * is true — it was passed to the team, who will confirm. Operator twin:
 * {@link OPERATOR_DRAFTED_FOR_REVIEW_COPY}.
 */
export const CALLER_REQUEST_QUEUED_COPY = TTS_COPY.caller_request_queued.en;

export const CALLER_INCOMPLETE_REQUEST_COPY = TTS_COPY.caller_incomplete_request.en;

/**
 * #1600 (1) (owner decision 2026-10-04) — spoken to an S1 caller identified
 * by caller-ID who names a DIFFERENT customer's account ("what's Jane Doe's
 * balance?"). Says plainly what the agent can do; never confirms or denies
 * that the named customer exists, and nothing of either account follows.
 * D-036 (1).3 (identity outranks words) is unchanged — this is only what
 * the caller hears instead of their own account being read in Jane's place.
 */
export const CROSS_CUSTOMER_REFUSAL_COPY = TTS_COPY.cross_customer_refusal.en;

/**
 * #1600 (2) (owner decision 2026-10-04) — spoken when the same write request
 * has been asked for the fifth time on one S1 call: the agent stops answering
 * it and hands the call to a person (transitions.ts `repeated_write_intent`).
 * Polite by design — a repeated request is not an accusation.
 */
export const REPEATED_REQUEST_HANDOFF_COPY = TTS_COPY.repeated_request_handoff.en;

/**
 * #1600 (3) — the caller declined the offer to book a new appointment; the
 * call stays open for whatever else they need.
 */
export const REBOOK_DECLINED_COPY = TTS_COPY.rebook_declined.en;

/**
 * #1600 (3) (owner decision 2026-10-04) — spoken when an S1 caller refers to
 * an appointment of theirs that is CANCELLED: the cancellation is disclosed
 * with its date and a new booking is offered. Templated (`rebook_offer`,
 * payload `cancelledOn` ISO + `timezone`) because the date is dynamic — an
 * exact-match catalog cannot localize it — so the date renders tenant-local
 * in the session language. Without a usable date the sentence still holds.
 */
export function rebookOfferLine(
  cancelledOnIso: string | undefined,
  timezone: string | undefined,
  lang: SessionLanguage,
): string {
  const date = cancelledOnIso ? formatCancelledOn(cancelledOnIso, timezone, lang) : undefined;
  if (lang === 'es') {
    return date
      ? `Esa cita se canceló el ${date} — ¿le gustaría reservar una nueva?`
      : 'Esa cita se canceló — ¿le gustaría reservar una nueva?';
  }
  return date
    ? `That appointment was cancelled on ${date} — would you like to book a new one?`
    : 'That appointment was cancelled — would you like to book a new one?';
}

function formatCancelledOn(
  iso: string,
  timezone: string | undefined,
  lang: SessionLanguage,
): string | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const locale = lang === 'es' ? 'es' : 'en-US';
  const parts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };
  try {
    return new Intl.DateTimeFormat(locale, { ...parts, ...(timezone ? { timeZone: timezone } : {}) }).format(at);
  } catch {
    // An unusable zone never costs the caller the sentence.
    return new Intl.DateTimeFormat(locale, parts).format(at);
  }
}

/**
 * UB-C1 — spoken acknowledgment after the media-stream adapter flips the
 * live call language on an explicit caller request ("hablo español" /
 * "switch to english"). Always spoken in the language being switched TO —
 * the caller just told us that's the one they understand.
 */
export const LANGUAGE_SWITCH_ACK: Record<SessionLanguage, string> = TTS_COPY.language_switch_ack;

/**
 * #846 — spoken when the caller asks for a language the tenant hasn't opted
 * into (`supported_languages` gate). Keyed by the language the call STAYS in
 * — the requested one is exactly what we can't speak.
 */
export const LANGUAGE_UNSUPPORTED_LINE: Record<SessionLanguage, string> =
  TTS_COPY.language_unsupported;

/**
 * #846 — spoken when the per-call language-switch cap
 * (MAX_LANGUAGE_SWITCHES_PER_CALL) is exhausted: the call keeps its current
 * language rather than flapping. Keyed by the language the call stays in.
 */
export const LANGUAGE_SWITCH_CAP_LINE: Record<SessionLanguage, string> =
  TTS_COPY.language_switch_cap;

/**
 * VOX-52 — voice a disambiguation prompt for an ambiguous entity reference.
 * `candidates` is the resolver's candidate set mapped to `{ id, name, score }`.
 * Speaks the distinct candidate names so the caller can choose; when the names
 * are indistinguishable (e.g. two customers both "Bob Smith"), reading them
 * back helps nobody, so we ask for a distinguishing detail instead. Never
 * picks for the caller.
 */
function renderDisambiguation(candidates: unknown, lang: SessionLanguage): string {
  const names = Array.isArray(candidates)
    ? candidates
        .map((c) =>
          c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string'
            ? ((c as { name: string }).name).trim()
            : '',
        )
        .filter((n) => n.length > 0)
    : [];
  const distinct = [...new Set(names)].slice(0, 3);

  // Identical or missing names → ask for a distinguishing detail rather than
  // reading the same name back.
  if (distinct.length < 2) return ttsCopy('disambiguation_same_name', lang);

  const list =
    lang === 'es'
      ? distinct.slice(0, -1).join(', ') + ' o ' + distinct[distinct.length - 1]
      : distinct.slice(0, -1).join(', ') + ' or ' + distinct[distinct.length - 1];
  return lang === 'es'
    ? `Encontré varias coincidencias — ¿se refiere a ${list}? ¿Cuál de ellas?`
    : `I found a few matches — did you mean ${list}? Which one?`;
}

export function renderTtsText(
  rawText: string,
  payload: Record<string, unknown>,
  lang: SessionLanguage,
): string {
  const template = typeof payload.template === 'string' ? payload.template : undefined;
  const key = template ?? (TEMPLATE_KEYS.has(rawText) ? rawText : undefined);
  if (!key) {
    // #1601 — a catalog id renders its entry, interpolating `{{vars}}` from
    // `payload.vars` (else from the payload itself).
    if (isTtsCopyId(rawText)) {
      const vars =
        typeof payload.vars === 'object' && payload.vars !== null
          ? (payload.vars as Record<string, unknown>)
          : payload;
      return ttsCopy(rawText, lang, vars);
    }
    // The FSM path: transitions.ts emits the fixed ENGLISH sentence as
    // `payload.text`; it resolves back to its catalog entry here so a
    // Spanish-language session never flips to English mid-call.
    if (lang === 'es') {
      const id = EN_SENTENCE_TO_ID.get(rawText);
      if (id) return TTS_COPY[id].es;
    }
    return rawText;
  }

  const intent = typeof payload.intent === 'string' ? payload.intent : undefined;
  switch (key) {
    case 'confirm_intent':
    case 'intent_confirm': {
      // #1539 — say WHAT will be drafted, from the request's own entities.
      const entities =
        typeof payload.entities === 'object' && payload.entities !== null
          ? (payload.entities as Record<string, unknown>)
          : undefined;
      // #1577 — a booking with no day or time asks for one first; the
      // readback comes once there is a time to read back.
      if (bookingAwaitsTime(intent, entities)) return ttsCopy('booking_awaits_time', lang);
      return lang === 'es'
        ? `Para confirmar: usted desea ${intentReadbackPhrase(intent, entities, 'es')}. ¿Es correcto?`
        : `Just to confirm — you'd like to ${intentReadbackPhrase(intent, entities, 'en')}. Is that right?`;
    }
    case 'disambiguate':
      // VOX-52 — a free-text reference matched more than one record above the
      // resolver threshold. Voice the distinct candidate names so the caller
      // can pick; if the names are identical (the "two Bobs" case) listing them
      // helps nobody, so ask for a distinguishing detail instead. Never guess.
      return renderDisambiguation(payload.candidates, lang);
    case 'confirm_entity': {
      // Middle confidence band (τ_ent_confirm_low <= score < τ_ent): a single
      // candidate was found but isn't confident enough to act on silently.
      // Read back its label and ask for a one-tap yes/no before using it.
      const entityKind = typeof payload.entityKind === 'string' ? payload.entityKind : undefined;
      const summary = typeof payload.summary === 'string' ? payload.summary : '';
      return lang === 'es'
        ? `Encontré ${entityKindArticleEs(entityKind)} ${entityKindLabel(entityKind, 'es')} "${summary}" — ¿es a la que se refiere?`
        : `I found a ${entityKindLabel(entityKind, 'en')} "${summary}" — is that the one you mean?`;
    }
    case 'entity_not_found_operator': {
      // SCH-D3 — the AUTHENTICATED OPERATOR's honest not-found. Distinct
      // from the caller-facing escalation line ("Let me connect you with a
      // team member"): an operator IS the team member, so the line names
      // what was searched for and offers the two real ways forward.
      // Templated rather than a fixed TTS_COPY entry because the
      // reference is dynamic — an exact-match catalog cannot localize it.
      const entityKind = typeof payload.entityKind === 'string' ? payload.entityKind : undefined;
      const reference = typeof payload.reference === 'string' ? payload.reference.trim() : '';
      if (!reference) {
        return lang === 'es'
          ? `No encontré ${entityKindArticleEs(entityKind)} ${entityKindLabel(entityKind, 'es')} que coincida. ¿Quiere intentar con otro nombre, o crearlo?`
          : `I couldn't find a matching ${entityKindLabel(entityKind, 'en')}. Want to try a different name, or create it?`;
      }
      return lang === 'es'
        ? `No encontré ${entityKindArticleEs(entityKind)} ${entityKindLabel(entityKind, 'es')} que coincida con ${reference}. ¿Quiere intentar con otro nombre, o crearlo?`
        : `I couldn't find a matching ${entityKindLabel(entityKind, 'en')} for ${reference}. Want to try a different name, or create it?`;
    }
    case 'rebook_offer':
      // #1600 (3) — the caller's cancelled appointment: disclose + offer to rebook.
      return rebookOfferLine(
        typeof payload.cancelledOn === 'string' ? payload.cancelledOn : undefined,
        typeof payload.timezone === 'string' ? payload.timezone : undefined,
        lang,
      );
    case 'greeting':
      return ttsCopy('greeting_plain', lang);
    case 'greeting_with_disclosure':
      return ttsCopy('greeting_with_disclosure', lang);
    default:
      return rawText;
  }
}
