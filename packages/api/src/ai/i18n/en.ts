/**
 * P11-002 — English voice-stack catalog. Source of truth for the
 * `TranslationKey` union; every key listed here MUST also exist in
 * `es.ts` (enforced by `Record<TranslationKey, string>` at compile
 * time + runtime catalog completeness test).
 */
export const en = {
  // ── Lookup: appointments ─────────────────────────────────────────────
  'lookup.appointments.error':
    "I'm having trouble pulling up your appointments right now. Let me get someone to help.",
  'lookup.appointments.none':
    "I'm not seeing any upcoming appointments on your account. Would you like to schedule one?",
  'lookup.appointments.single':
    'Your next appointment is {{when}} for {{summary}}.',
  'lookup.appointments.multiple_one_more':
    'Your next appointment is {{when}} for {{summary}}. You also have one more on {{others}}.',
  'lookup.appointments.multiple_many':
    'Your next appointment is {{when}} for {{summary}}. You also have appointments on {{others}}.',

  // ── Lookup: balance ──────────────────────────────────────────────────
  'lookup.balance.error':
    "I'm having trouble checking your balance right now.",
  'lookup.balance.none':
    'Your account is paid in full — nothing currently owed.',
  'lookup.balance.summary':
    'You currently owe {{amount}} across {{count}} open invoice(s).',

  // ── Lookup: invoices ─────────────────────────────────────────────────
  'lookup.invoices.error':
    "I'm having trouble pulling up your invoices right now.",
  'lookup.invoices.none':
    "You don't have any open invoices on your account.",
  'lookup.invoices.single':
    'You have one open invoice for {{amount}}.',
  'lookup.invoices.multiple':
    'You have {{count}} open invoices totaling {{amount}}.',

  // ── Lookup: jobs ─────────────────────────────────────────────────────
  'lookup.jobs.error':
    "I'm having trouble pulling up your jobs right now.",
  'lookup.jobs.none':
    "I'm not seeing any active jobs on your account right now.",
  'lookup.jobs.summary':
    'You have {{count}} job(s): {{summary}}.',

  // ── Lookup: agreements ───────────────────────────────────────────────
  'lookup.agreements.error':
    "I'm having trouble checking your service plan right now.",
  'lookup.agreements.none':
    "I'm not seeing an active service agreement on your account.",
  'lookup.agreements.summary':
    'You have an active {{name}} plan.',

  // ── Lookup: account summary ──────────────────────────────────────────
  'lookup.account.error':
    "I'm having trouble pulling up your account right now.",
  'lookup.account.empty':
    "I'm not seeing anything notable on your account right now.",

  // ── Telephony greeting (default opener) ──────────────────────────────
  'greeting.opener_default': 'Thank you for calling {{business}}.',
  'greeting.opener_named': 'Thank you for calling {{business}}. This is {{agent}}.',
  'greeting.cta': 'How can I help you today?',

  // ── Caller identification ────────────────────────────────────────────
  'identify.greet_known': 'Hi {{name}}, welcome back.',
  'identify.greet_unknown':
    "Hi, thanks for calling. I don't have you in our system yet.",

  // ── Escalation ───────────────────────────────────────────────────────
  'escalate.transferring':
    'One moment — I am transferring you to a team member who can help.',
  'escalate.no_dispatcher':
    "I'm sorry, no one is available right now. {{business}} will call you back as soon as possible. Thank you for calling.",

  // ── Recording disclosure ─────────────────────────────────────────────
  'disclose.two_party':
    'This call may be recorded for quality and training purposes. By continuing, you consent to this recording.',
  'disclose.one_party':
    'This call may be recorded for quality and training purposes.',

  // ── Confirm intent (readback) ────────────────────────────────────────
  'confirm.readback':
    'Just to confirm — {{summary}}. Is that right?',

  // ── Language switch ──────────────────────────────────────────────────
  'language.switched_to_es':
    'De acuerdo, vamos a continuar en español.',
  'language.switched_to_en':
    "Got it — we'll continue in English.",

  // ── Generic fallback ─────────────────────────────────────────────────
  'generic.help_someone':
    "Let me get someone to help.",
} as const;

export type EnglishCatalog = typeof en;
