/**
 * P11-002 — Spanish voice-stack catalog. MUST mirror the EN catalog
 * key-for-key; the type assertion `Record<keyof EnglishCatalog, string>`
 * enforces this at compile time. Adding a new EN key without an ES
 * translation breaks `tsc`.
 */
import type { EnglishCatalog } from './en';

export const es: Record<keyof EnglishCatalog, string> = {
  // ── Lookup: appointments ─────────────────────────────────────────────
  'lookup.appointments.error':
    'Tengo problemas para revisar sus citas en este momento. Déjeme conectarle con alguien que pueda ayudar.',
  'lookup.appointments.none':
    'No veo ninguna cita próxima en su cuenta. ¿Le gustaría programar una?',
  'lookup.appointments.single':
    'Su próxima cita es el {{when}} para {{summary}}.',
  'lookup.appointments.multiple_one_more':
    'Su próxima cita es el {{when}} para {{summary}}. También tiene una más el {{others}}.',
  'lookup.appointments.multiple_many':
    'Su próxima cita es el {{when}} para {{summary}}. También tiene citas el {{others}}.',

  // ── Lookup: balance ──────────────────────────────────────────────────
  'lookup.balance.error':
    'Tengo problemas para consultar su saldo en este momento.',
  'lookup.balance.none':
    'Su cuenta está pagada en su totalidad — no debe nada actualmente.',
  'lookup.balance.summary':
    'Actualmente debe {{amount}} en {{count}} factura(s) abierta(s).',

  // ── Lookup: invoices ─────────────────────────────────────────────────
  'lookup.invoices.error':
    'Tengo problemas para revisar sus facturas en este momento.',
  'lookup.invoices.none':
    'No tiene facturas abiertas en su cuenta.',
  'lookup.invoices.single':
    'Tiene una factura abierta por {{amount}}.',
  'lookup.invoices.multiple':
    'Tiene {{count}} facturas abiertas por un total de {{amount}}.',

  // ── Lookup: jobs ─────────────────────────────────────────────────────
  'lookup.jobs.error':
    'Tengo problemas para revisar sus trabajos en este momento.',
  'lookup.jobs.none':
    'No veo ningún trabajo activo en su cuenta en este momento.',
  'lookup.jobs.summary':
    'Tiene {{count}} trabajo(s): {{summary}}.',

  // ── Lookup: agreements ───────────────────────────────────────────────
  'lookup.agreements.error':
    'Tengo problemas para revisar su plan de servicio en este momento.',
  'lookup.agreements.none':
    'No veo ningún acuerdo de servicio activo en su cuenta.',
  'lookup.agreements.summary':
    'Tiene un plan {{name}} activo.',

  // ── Lookup: account summary ──────────────────────────────────────────
  'lookup.account.error':
    'Tengo problemas para revisar su cuenta en este momento.',
  'lookup.account.empty':
    'No veo nada destacado en su cuenta en este momento.',

  // ── Telephony greeting (default opener) ──────────────────────────────
  'greeting.opener_default': 'Gracias por llamar a {{business}}.',
  'greeting.opener_named': 'Gracias por llamar a {{business}}. Le atiende {{agent}}.',
  'greeting.cta': '¿En qué puedo ayudarle hoy?',
  'greeting.one_moment': 'Un momento, por favor.',

  // ── Caller identification ────────────────────────────────────────────
  'identify.greet_known': 'Hola {{name}}, bienvenido de nuevo.',
  'identify.greet_unknown':
    'Hola, gracias por llamar. Aún no le tengo registrado en nuestro sistema.',

  // ── Escalation ───────────────────────────────────────────────────────
  'escalate.transferring':
    'De acuerdo, déjeme comunicarle con alguien ahora mismo.',
  'escalate.no_dispatcher':
    'Lo siento, no hay nadie disponible en este momento. {{business}} le devolverá la llamada lo antes posible. Gracias por llamar.',
  // Voice-parity (Feature 7) — la transferencia falló; tomar un mensaje.
  'callback.prompt':
    'Lo siento, no pude comunicarme con nadie en este momento. Dígame brevemente qué necesita y el mejor número para llamarle, y alguien le devolverá la llamada en seguida.',
  'callback.ack':
    'Gracias. Alguien de {{business}} le devolverá la llamada lo antes posible. Hasta luego.',
  // WS7 — repair prompt when a live call degrades from realtime to Gather.
  'realtime.degraded_repair': 'Disculpe la interrupción — sigo aquí. ¿En qué puedo ayudarle?',

  // ── Recording disclosure ─────────────────────────────────────────────
  'disclose.two_party':
    'Esta llamada puede ser grabada con fines de calidad y entrenamiento. Al continuar, usted consiente esta grabación.',
  'disclose.one_party':
    'Esta llamada puede ser grabada con fines de calidad y entrenamiento.',

  // ── Confirm intent (readback) ────────────────────────────────────────
  'confirm.readback':
    'Solo para confirmar — {{summary}}. ¿Es correcto?',

  // ── Language switch ──────────────────────────────────────────────────
  'language.switched_to_es':
    'De acuerdo, vamos a continuar en español.',
  'language.switched_to_en':
    "Got it — we'll continue in English.",

  // ── Generic fallback ─────────────────────────────────────────────────
  'generic.help_someone':
    'Déjeme conectarle con alguien que pueda ayudar.',
};
