/**
 * #1601 step 1 — characterisation of the spoken-copy catalog.
 *
 * Every spoken line the voice surfaces say used to live inline in the turn
 * processor, the Gather adapter, the in-app adapter, the FSM transition table
 * and the quote read-back, with Spanish keyed on the exact English sentence in
 * `SENTENCE_CATALOG_ES`. This test pins, BEFORE the move, what each id must
 * render in English and Spanish, so moving the text into `TTS_COPY` is
 * provably text-identical:
 *
 *   - `en` is the literal copied from the pre-move source file (the
 *     independent source of truth — not derived from the catalog);
 *   - `es` is the Spanish that shipped in `SENTENCE_CATALOG_ES` /
 *     `LANGUAGE_*` / `renderTtsText` where one existed, otherwise the new
 *     translation written for #1601 (those are marked `// es: new 1601` in the
 *     catalog for review).
 *
 * Parameterised entries carry `{{var}}` placeholders (the same syntax as
 * `ai/i18n`); their raw templates are pinned here and their interpolation is
 * pinned in the sibling test below.
 */
import { describe, it, expect } from 'vitest';
import {
  TTS_COPY,
  ttsCopy,
  renderTtsText,
  type TtsCopyId,
} from '../../../../src/ai/agents/customer-calling/tts-copy';

interface Pinned {
  en: string;
  es: string;
  /** Sample interpolation for a parameterised entry: vars → exact English heard. */
  sample?: { vars: Record<string, string>; en: string };
}

const SNAPSHOT: Record<string, Pinned> = {
  // ── already named in tts-copy.ts before #1601 ─────────────────────────────
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
  out_of_service_area: {
    en: "We don't usually service that area, but I'll pass your details to the team.",
    es: 'Normalmente no damos servicio en esa zona, pero le pasaré sus datos al equipo.',
  },
  service_area_zip_question: {
    en: "Sure — what's the ZIP code for the address where you need the service?",
    es: 'Claro — ¿cuál es el código postal de la dirección donde necesita el servicio?',
  },
  emergency_safety_line: {
    en: 'If anyone is in immediate danger, hang up and call 911.',
    es: 'Si alguien está en peligro inmediato, cuelgue y llame al 911.',
  },
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
  greeting_plain: {
    en: 'Hi! How can I help you today?',
    es: '¡Hola! ¿En qué puedo ayudarle hoy?',
  },
  greeting_with_disclosure: {
    en: "Hi, I'm a virtual assistant. How can I help you today?",
    es: 'Hola, soy un asistente virtual. ¿En qué puedo ayudarle hoy?',
  },
  booking_awaits_time: {
    en: 'What date and time work for you?',
    es: '¿Qué fecha y hora le convienen?',
  },
  disambiguation_same_name: {
    en: 'I found more than one record under that name. Could you give me the service address so I can pick the right one?',
    es: 'Encontré más de un registro con ese nombre. ¿Me puede dar la dirección de servicio para elegir el correcto?',
  },

  // ── transitions.ts (FSM), Spanish shipped in SENTENCE_CATALOG_ES ─────────
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
  how_can_i_help: {
    en: 'How can I help you today?',
    es: '¿En qué puedo ayudarle hoy?',
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

  // ── transitions.ts (FSM), Spanish new for #1601 ──────────────────────────
  refinement_cap: {
    en: 'Let me have the owner finalize the details and send you the full quote by text.',
    es: 'Permítame que el propietario finalice los detalles y le envíe el presupuesto completo por mensaje de texto.',
  },
  post_quote_reprompt: {
    en: 'Sorry — did you want me to lock that in, or is there something to change?',
    es: 'Disculpe — ¿quiere que lo deje confirmado, o hay algo que cambiar?',
  },
  negotiation_holding: {
    en: "That's a good question — I'll need to check with the owner on that, and we'll get right back to you. Is there anything else I can help with in the meantime?",
    es: 'Es una buena pregunta — tendré que consultarlo con el propietario y le responderemos enseguida. ¿Hay algo más en lo que pueda ayudarle mientras tanto?',
  },
  complaint_escalation: {
    en: "I'm sorry to hear that — let me get a person on the line to help you right away.",
    es: 'Lamento escuchar eso — enseguida le paso con una persona para que le ayude.',
  },
  confirm_nothing_pending: {
    en: "I don't have anything waiting on a yes from you just yet — what would you like to do?",
    es: 'Por ahora no tengo nada pendiente de su confirmación — ¿qué le gustaría hacer?',
  },
  farewell_close: {
    en: 'Okay — talk soon. Goodbye!',
    es: 'De acuerdo — hasta pronto. ¡Adiós!',
  },
  technical_issue_escalation: {
    en: "One moment — I'm having a brief technical issue. Let me connect you with a team member.",
    es: 'Un momento — tengo un breve problema técnico. Le comunico con un miembro del equipo.',
  },
  caller_id_mismatch_reask: {
    en: 'Sorry about that. Who am I speaking with, and how can I help you today?',
    es: 'Disculpe. ¿Con quién hablo, y en qué puedo ayudarle hoy?',
  },
  confirm_repeat_reprompt: {
    en: 'I want to make sure I got that right — can you say that again?',
    es: 'Quiero asegurarme de haberlo entendido bien — ¿podría repetirlo?',
  },

  // ── create-voice-turn-processor.ts ───────────────────────────────────────
  post_quote_affirmative_interim: {
    en: "Perfect — I'll have the owner finalize that and send you the full quote and booking link by text.",
    es: 'Perfecto — haré que el propietario lo finalice y le envíe el presupuesto completo y el enlace de reserva por mensaje de texto.',
  },
  sms_consent_ask: {
    en: "Great — I can text the full quote and a link to lock in your booking. Is it okay to send that to the number you're calling from?",
    es: 'Muy bien — puedo enviarle por mensaje de texto el presupuesto completo y un enlace para confirmar su reserva. ¿Le parece bien que lo envíe al número desde el que llama?',
  },
  sms_consent_grant_ack: {
    en: "Perfect — you'll get that text shortly.",
    es: 'Perfecto — recibirá ese mensaje de texto en breve.',
  },
  sms_consent_decline_fallback: {
    en: "No problem — I'll have the owner send that over, and you'll get a text shortly.",
    es: 'No hay problema — haré que el propietario se lo envíe, y recibirá un mensaje de texto en breve.',
  },
  close_fallback: {
    en: "Great — I'll have the owner confirm your booking, and you'll get the quote by text shortly.",
    es: 'Muy bien — haré que el propietario confirme su reserva, y recibirá el presupuesto por mensaje de texto en breve.',
  },
  no_detail_yet: {
    en: "I don't have that detail on this one yet.",
    es: 'Todavía no tengo ese dato para esta solicitud.',
  },
  drafted_with_gaps: {
    en: "I've drafted that. {{ask}}",
    es: 'Lo dejé como borrador. {{ask}}',
    sample: {
      vars: { ask: 'What phone number should I use?' },
      en: "I've drafted that. What phone number should I use?",
    },
  },
  voicemail_no_one_available: {
    en: "I'm sorry, no one is available right now. {{business}} will call you back as soon as possible. Thank you for calling.",
    es: 'Lo siento, no hay nadie disponible en este momento. {{business}} le devolverá la llamada lo antes posible. Gracias por llamar.',
    sample: {
      vars: { business: 'Acme Plumbing' },
      en: "I'm sorry, no one is available right now. Acme Plumbing will call you back as soon as possible. Thank you for calling.",
    },
  },
  signup_ask_name: {
    en: 'Of course — could I get your name to get you set up?',
    es: 'Por supuesto — ¿me puede dar su nombre para registrarle?',
  },
  signup_ask_callback: {
    en: "I'm sorry, I couldn't see your number. What's the best phone number to reach you on?",
    es: 'Lo siento, no pude ver su número. ¿Cuál es el mejor número de teléfono para comunicarnos con usted?',
  },
  signup_persist_failed: {
    en: "I'm having trouble saving that. Let me get a person to help you finish signing up.",
    es: 'Tengo dificultades para guardar eso. Le paso con una persona para que le ayude a terminar el registro.',
  },
  session_ended_call_again: {
    en: "I'm sorry, your session has ended. Please call again.",
    es: 'Lo siento, su sesión ha terminado. Por favor, llame de nuevo.',
  },
  anything_else: {
    en: 'Anything else I can help you with?',
    es: '¿Hay algo más en lo que pueda ayudarle?',
  },

  // ── twilio-adapter.ts ────────────────────────────────────────────────────
  missing_session_greeting: {
    en: 'Thank you for calling {{business}}. How can I help you today?',
    es: 'Gracias por llamar a {{business}}. ¿En qué puedo ayudarle hoy?',
    sample: {
      vars: { business: 'Acme Plumbing' },
      en: 'Thank you for calling Acme Plumbing. How can I help you today?',
    },
  },

  // ── inapp-adapter.ts ─────────────────────────────────────────────────────
  inapp_default_greeting: {
    en: 'Hi, this is your assistant. How can I help today?',
    es: 'Hola, soy su asistente. ¿En qué puedo ayudarle hoy?',
  },
  inapp_named_greeting: {
    en: "Hi, I'm {{agent}}. How can I help today?",
    es: 'Hola, soy {{agent}}. ¿En qué puedo ayudarle hoy?',
    sample: { vars: { agent: 'Riley' }, en: "Hi, I'm Riley. How can I help today?" },
  },
  noise_reprompt: {
    en: "I didn't catch that — what would you like to do?",
    es: 'No alcancé a escuchar eso — ¿qué le gustaría hacer?',
  },

  // ── voice-turn/quote-readback.ts ─────────────────────────────────────────
  uncatalogued_quote_readback: {
    en: "I've got the details — the owner will confirm pricing and you'll get the full quote by text.",
    es: 'Ya tengo los detalles — el propietario confirmará el precio y recibirá el presupuesto completo por mensaje de texto.',
  },
  quote_readback_single: {
    en: "For the {{description}}, that's typically {{price}}. I'll send the full quote to confirm.",
    es: 'Para {{description}}, normalmente son {{price}}. Le enviaré el presupuesto completo para confirmarlo.',
    sample: {
      vars: { description: 'water heater', price: '$1,850' },
      en: "For the water heater, that's typically $1,850. I'll send the full quote to confirm.",
    },
  },
  quote_readback_lines_total: {
    en: "{{lines}} — that's {{total}} all together. I'll send the full quote to confirm.",
    es: '{{lines}} — en total son {{total}}. Le enviaré el presupuesto completo para confirmarlo.',
    sample: {
      vars: { lines: 'The water heater is $1,850, and the gasket is $9', total: '$1,859' },
      en: "The water heater is $1,850, and the gasket is $9 — that's $1,859 all together. I'll send the full quote to confirm.",
    },
  },
  quote_readback_total_only: {
    en: "That usually comes to about {{total}} all together. I'll send the full quote to confirm.",
    es: 'Normalmente suma unos {{total}} en total. Le enviaré el presupuesto completo para confirmarlo.',
    sample: {
      vars: { total: '$4,120' },
      en: "That usually comes to about $4,120 all together. I'll send the full quote to confirm.",
    },
  },
  // ── #1604 — ai/skills/lookup-next-job.ts ──────────────────────────────────
  next_job_when_today: {
    en: 'today at {{time}}',
    es: 'hoy a las {{time}}',
    sample: { vars: { time: '2 PM' }, en: 'today at 2 PM' },
  },
  next_job_when_tomorrow: {
    en: 'tomorrow at {{time}}',
    es: 'mañana a las {{time}}',
    sample: { vars: { time: '9 AM' }, en: 'tomorrow at 9 AM' },
  },
  next_job_when_on_day: {
    en: 'on {{day}} at {{time}}',
    es: 'el {{day}} a las {{time}}',
    sample: { vars: { day: 'Friday, June 12', time: '9 AM' }, en: 'on Friday, June 12 at 9 AM' },
  },
  next_job_readback: {
    en: 'Your next job is {{when}} — {{customer}}, {{job}}, at {{address}}.',
    es: 'Su próximo trabajo es {{when}} — {{customer}}, {{job}}, en {{address}}.',
    sample: {
      vars: {
        when: 'today at 2 PM',
        customer: 'Dana Keller',
        job: 'Water heater replacement',
        address: '4120 East Oakhurst Boulevard, Yonkers',
      },
      en: 'Your next job is today at 2 PM — Dana Keller, Water heater replacement, at 4120 East Oakhurst Boulevard, Yonkers.',
    },
  },
  next_job_access_notes: {
    en: 'Access notes: {{notes}}',
    es: 'Notas de acceso: {{notes}}',
    sample: { vars: { notes: 'Gate code 4421, dog in the yard.' }, en: 'Access notes: Gate code 4421, dog in the yard.' },
  },
  next_job_latest_note: {
    en: 'Latest note: {{note}}',
    es: 'Última nota: {{note}}',
    sample: {
      vars: { note: 'Customer prefers a text before arrival.' },
      en: 'Latest note: Customer prefers a text before arrival.',
    },
  },
};

const isParameterised = (s: string): boolean => /\{\{\w+\}\}/.test(s);

/**
 * Language-pair entries whose two sides are NOT translations of one sentence:
 * each is spoken in the language the call is in (or switching to), so the
 * English side must keep passing through on an es session — exactly as it did
 * before the move (`SENTENCE_CATALOG_ES` never listed them).
 */
const LANGUAGE_PAIRS: ReadonlySet<string> = new Set([
  'language_switch_ack',
  'language_unsupported',
  'language_switch_cap',
]);

describe('#1601 — TTS_COPY characterisation: every id renders the pre-move text', () => {
  it('ttsCopy(id, lang) is byte-identical to the pinned English and Spanish for every id', () => {
    for (const [id, pinned] of Object.entries(SNAPSHOT)) {
      expect(ttsCopy(id as TtsCopyId, 'en'), `${id} en`).toBe(pinned.en);
      expect(ttsCopy(id as TtsCopyId, 'es'), `${id} es`).toBe(pinned.es);
    }
  });

  it('the catalog carries exactly the pinned ids — no unpinned copy, no stale pin', () => {
    expect(Object.keys(TTS_COPY).sort()).toEqual(Object.keys(SNAPSHOT).sort());
  });

  it('no two ids share an English sentence — the FSM path resolves English back to ONE entry', () => {
    const byEnglish = new Map<string, string[]>();
    for (const [id, entry] of Object.entries(TTS_COPY)) {
      if (LANGUAGE_PAIRS.has(id)) continue;
      byEnglish.set(entry.en, [...(byEnglish.get(entry.en) ?? []), id]);
    }
    const shared = [...byEnglish.entries()].filter(([, ids]) => ids.length > 1);
    expect(shared, 'ids sharing one English sentence').toEqual([]);
  });
});

describe('#1601 — renderTtsText keeps resolving fixed English sentences (the FSM path)', () => {
  it('a fixed English sentence renders its Spanish twin on an es session and passes through on en', () => {
    for (const [id, pinned] of Object.entries(SNAPSHOT)) {
      if (isParameterised(pinned.en) || LANGUAGE_PAIRS.has(id)) continue;
      expect(renderTtsText(pinned.en, {}, 'es'), `${id} es`).toBe(pinned.es);
      expect(renderTtsText(pinned.en, {}, 'en'), `${id} en`).toBe(pinned.en);
    }
  });

  it('the language-pair lines are not cross-rendered: their English passes through on es', () => {
    for (const id of LANGUAGE_PAIRS) {
      const pinned = SNAPSHOT[id]!;
      expect(renderTtsText(pinned.en, {}, 'es'), id).toBe(pinned.en);
    }
  });
});

describe('#1601 — renderTtsText resolves a catalog id', () => {
  it('an id as the raw text renders the entry in the session language', () => {
    expect(renderTtsText('anything_else', {}, 'en')).toBe(SNAPSHOT.anything_else.en);
    expect(renderTtsText('anything_else', {}, 'es')).toBe(SNAPSHOT.anything_else.es);
  });
});

describe('#1601 — parameterised entries interpolate {{vars}}', () => {
  it('each pinned sample renders the exact English the caller heard before the move', () => {
    for (const [id, pinned] of Object.entries(SNAPSHOT)) {
      if (!pinned.sample) continue;
      expect(ttsCopy(id as TtsCopyId, 'en', pinned.sample.vars), id).toBe(pinned.sample.en);
    }
  });

  it('a missing var renders empty rather than leaking the placeholder', () => {
    expect(ttsCopy('inapp_named_greeting', 'en', {})).toBe("Hi, I'm . How can I help today?");
  });
});
