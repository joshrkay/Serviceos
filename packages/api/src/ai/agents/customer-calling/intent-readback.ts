/**
 * #1539 — what the `intent_confirm` readback says will be drafted.
 *
 * "Just to confirm — you'd like to take care of that request" asked the
 * caller to confirm something the agent never stated, so a "yes" confirmed
 * nothing and a misheard request was drafted anyway. This builds the
 * specific phrase from the request's own entities (the classifier's words,
 * merged across turns — never a value read off a record), per write intent,
 * in English and Spanish.
 *
 * ONE implementation: `renderTtsText`'s `confirm_intent` template (tts-copy)
 * is the only caller, and every surface renders the readback through it —
 * in-app, the Gather <Say>, media streams, and the phone turn engine's
 * transcript line (`expandIntentConfirmTemplate`).
 *
 * The phrase completes "you'd like to …" / "usted desea …".
 */
import type { SessionLanguage } from './tts-copy';
import { normalizeSpokenEmail } from './spoken-email';

type Entities = Record<string, unknown>;
type Phrase = (e: Entities) => string;

function text(e: Entities, key: string): string | undefined {
  const v = e[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** "for Dana Reyes" — or nothing when no name was given. */
function suffix(prefix: string, value: string | undefined): string {
  return value ? `${prefix}${value}` : '';
}

function num(e: Entities, key: string): number | undefined {
  const v = e[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Integer cents → spoken dollars ("$50", "$200.50"). The classifier's money
 * field is `amount` (integer cents, entity dictionary).
 */
function money(e: Entities, key = 'amount'): string | undefined {
  const cents = num(e, key);
  if (cents === undefined || !Number.isInteger(cents)) return undefined;
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? `$${dollars}` : `$${dollars}.${String(rest).padStart(2, '0')}`;
}

/** "a $50 credit" / "a credit". */
function amountOf(amount: string | undefined, noun: string): string {
  return amount ? `a ${amount} ${noun}` : `a ${noun}`;
}

const PAID_EN: Record<string, string> = {
  cash: 'paid in cash',
  check: 'paid by check',
  card: 'paid by card',
  card_external: 'paid by card',
};

const EN: Record<string, Phrase> = {
  create_appointment: (e) => scheduleEn('an appointment', e),
  create_booking: (e) => scheduleEn('an appointment', e),
  apply_credit: (e) =>
    `apply ${amountOf(money(e), 'credit')}${suffix(' for ', text(e, 'customerName'))}`,
  record_refund: (e) =>
    `record ${amountOf(money(e), 'refund')}${suffix(' for ', text(e, 'customerName'))}${suffix(
      ', ',
      PAID_EN[text(e, 'refundMethod') ?? ''],
    )}`,
  record_payment: (e) =>
    `record ${amountOf(money(e), 'payment')}${suffix(' from ', text(e, 'customerName'))}${suffix(
      ', ',
      PAID_EN[text(e, 'paymentMethod') ?? ''],
    )}`,
  log_expense: (e) =>
    `log ${amountOf(money(e), 'expense')}${suffix(' for ', text(e, 'expenseDescription'))}${suffix(
      ' from ',
      text(e, 'vendor'),
    )}${suffix(' on ', text(e, 'jobReference'))}`,
  log_mileage: (e) => {
    const miles = num(e, 'mileageMiles');
    return `log ${miles !== undefined ? `${miles} miles` : 'mileage'}${suffix(' on ', text(e, 'jobReference'))}`;
  },
  // ── invoices & estimates ──
  create_invoice: (e) => `draft an invoice${forWhom(e)}${suffix(': ', items(e, 'and'))}`,
  update_invoice: (e) => `update the invoice${forWhom(e)}${suffix(' with ', items(e, 'and'))}`,
  issue_invoice: (e) => `issue the invoice${forWhom(e)}`,
  send_invoice: (e) =>
    `send the invoice${forWhom(e)}${suffix(' by ', CHANNEL_EN[text(e, 'sendChannel') ?? ''])}`,
  batch_invoice: () => 'invoice all your completed jobs',
  send_payment_reminder: (e) =>
    `send a payment reminder${suffix(' to ', text(e, 'customerName')) || suffix(' for ', text(e, 'jobReference'))}`,
  apply_late_fee: (e) => `add ${amountOf(money(e), 'late fee')} to the invoice${forWhom(e)}`,
  draft_estimate: (e) => `put together an estimate${forWhom(e)}${suffix(': ', items(e, 'and'))}`,
  update_estimate: (e) => `update the estimate${forWhom(e)}${suffix(' with ', items(e, 'and'))}`,
  send_estimate: (e) => `send the estimate${forWhom(e)}`,
  send_estimate_nudge: (e) => `send a follow-up on the estimate${forWhom(e)}`,
  // ── customers & leads ──
  create_customer: (e) => {
    const who = text(e, 'displayName') ?? text(e, 'customerName');
    return who ? `add ${who} as a new customer` : 'add a new customer';
  },
  update_customer: (e) => {
    const changes = list(
      CUSTOMER_FIELDS_EN.flatMap(([key, label]) => {
        const v = text(e, key);
        return v ? [`${label} to ${customerFieldValue(key, v)}`] : [];
      }),
      'and',
    );
    const who = text(e, 'customerName');
    if (!changes) return `update ${who ? `${who}'s details` : 'the customer'}`;
    return `update ${who ? `${who}'s` : 'the customer'} ${changes}`;
  },
  add_service_location: (e) =>
    `add ${text(e, 'serviceAddress') ?? 'a service location'}${
      text(e, 'serviceAddress') ? ' as a service location' : ''
    }${suffix(' for ', text(e, 'customerName'))}`,
  convert_lead: (e) => `convert ${leadEn(e)} into a customer`,
  mark_lead_lost: (e) => `mark ${leadEn(e)} as lost${suffix(': ', text(e, 'lostReason'))}`,
  // ── jobs, notes & time ──
  create_job: (e) => `open a new job${forWhom(e)}${suffix(': ', text(e, 'jobTitle'))}`,
  update_job: (e) => `update ${text(e, 'jobReference') ?? `the job${suffix(' for ', text(e, 'customerName'))}`}`,
  emergency_dispatch: (e) =>
    `send out an emergency call${forWhom(e)}${suffix(': ', text(e, 'problemDescription'))}`,
  log_warranty_claim: (e) =>
    `log a warranty claim${forWhom(e)}${suffix(': ', stripPrefix(text(e, 'jobTitle'), 'Warranty'))}`,
  add_note: (e) => `add a note${forWhom(e)}${suffix(': ', text(e, 'noteBody'))}`,
  log_permit: (e) => {
    const permit = stripPrefix(text(e, 'noteBody'), 'PERMIT');
    return `log ${permit ? `permit ${permit}` : 'a permit'}${forWhom(e)}`;
  },
  log_time_entry: (e) => {
    const minutes = num(e, 'durationMinutes');
    return `log ${minutes !== undefined ? `${durationEn(minutes)} of time` : 'time'}${suffix(
      ' on ',
      text(e, 'jobReference'),
    )}`;
  },
  schedule_inspection: (e) => {
    const kind = stripPrefix(text(e, 'jobTitle'), 'Inspection');
    return scheduleEn(kind ? `${article(kind)} ${kind} inspection` : 'an inspection', e);
  },
  // ── messages to the customer ──
  send_customer_message: (e) =>
    `${text(e, 'customerMessageChannel') === 'email' ? 'email' : 'text'} ${customerEn(e)}${suffix(
      ': ',
      text(e, 'customerMessageBody'),
    )}`,
  request_feedback: (e) => `ask ${customerEn(e)} for a review`,
  notify_delay: (e) => {
    const delay = num(e, 'delayMinutes');
    return `let ${customerEn(e)} know you're running ${delay !== undefined ? `${durationEn(delay)} ` : ''}late`;
  },
  // ── changes to an existing appointment ──
  reschedule_appointment: (e) =>
    `move ${appointmentEn(e)}${suffix(' to ', text(e, 'newDateTimeDescription'))}`,
  cancel_appointment: (e) => `cancel ${appointmentEn(e)}`,
  confirm_appointment: (e) => `confirm ${appointmentEn(e)}`,
  reassign_appointment: (e) => `put ${technicianEn(e, 'another technician')} on ${appointmentEn(e)}`,
  add_crew_member: (e) => `add ${technicianEn(e, 'a crew member')} to ${appointmentEn(e)}`,
  remove_crew_member: (e) => `take ${technicianEn(e, 'a crew member')} off ${appointmentEn(e)}`,
  // ── materials, price book, agreements & settings ──
  add_material: (e) => {
    const qty = num(e, 'materialQuantity');
    return `add ${text(e, 'materialDescription') ?? 'that'}${qty !== undefined && qty > 1 ? `, quantity ${qty},` : ''} to the shopping list${suffix(
      ' for ',
      text(e, 'jobReference'),
    )}${suffix(', needed by ', text(e, 'materialNeededBy'))}`;
  },
  add_catalog_item: (e) =>
    `add ${text(e, 'catalogItemNewName') ?? 'an item'} to your price book${suffix(
      ' at ',
      money(e, 'unitPriceCents'),
    )}`,
  update_catalog_item: (e) => {
    const item = text(e, 'catalogItemReference') ?? 'that price-book item';
    const price = money(e, 'unitPriceCents');
    if (price) return `change the price of ${item} to ${price}`;
    const newName = text(e, 'catalogItemNewName');
    return newName ? `rename ${item} to ${newName}` : `update ${item}`;
  },
  create_change_order: (e) =>
    `create a change order${forWhom(e)}${suffix(': ', text(e, 'changeOrderDescription'))}${suffix(
      ', for ',
      money(e),
    )}`,
  create_service_agreement: (e) => {
    const plan = text(e, 'serviceAgreementName');
    return `sign ${customerEn(e)} up for ${plan ? withThe(plan) : 'a service agreement'}${suffix(
      ', ',
      CADENCE_EN[text(e, 'serviceAgreementCadence') ?? ''],
    )}`;
  },
  create_invoice_schedule: (e) =>
    `set up a payment schedule${forWhom(e)}${suffix(': ', text(e, 'scheduleDescription'))}`,
  respond_to_review: (e) => `respond to ${text(e, 'reviewReference') ?? 'that review'}`,
  create_standing_instruction: (e) =>
    `save a standing rule${suffix(': ', text(e, 'instructionText'))}`,
  update_brand_voice: (e) =>
    `update your brand voice${suffix(': ', text(e, 'brandVoiceInstruction'))}`,
};

const CADENCE_EN: Record<string, string> = {
  monthly: 'monthly',
  quarterly: 'quarterly',
  twice_a_year: 'twice a year',
  annual: 'once a year',
};

/** The caller's own words for the appointment; "your appointment" when none were given. */
function appointmentEn(e: Entities): string {
  const ref = text(e, 'appointmentReference');
  if (ref) return asObject(ref);
  const name = text(e, 'customerName');
  return name ? `${name}'s appointment` : 'your appointment';
}

/** A spoken reference used mid-sentence: "The Garcia appointment" → "the Garcia appointment". */
function asObject(ref: string): string {
  return ref.replace(/^(The|La|El)\s/, (article) => article.toLowerCase());
}

function technicianEn(e: Entities, fallback: string): string {
  return text(e, 'targetTechnicianName') ?? fallback;
}

function withThe(name: string): string {
  return /^(the|a|an)\s/i.test(name) ? name : `the ${name}`;
}

function customerEn(e: Entities): string {
  return text(e, 'customerName') ?? 'the customer';
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** "Warranty — water heater leaking" → "water heater leaking"; "PERMIT: 2024-1187" → "2024-1187". */
function stripPrefix(value: string | undefined, prefix: string): string | undefined {
  if (!value) return undefined;
  const stripped = value.replace(new RegExp(`^${prefix}\\s*[—:–-]\\s*`, 'i'), '').trim();
  return stripped.length > 0 ? stripped : undefined;
}

function durationEn(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  const hours = h === 0 ? '' : `${h} hour${h === 1 ? '' : 's'}`;
  const mins = m === 0 ? '' : `${m} minute${m === 1 ? '' : 's'}`;
  return [hours, mins].filter(Boolean).join(' ') || `${minutes} minutes`;
}

/**
 * #1613 — a new email address is carried as the ADDRESS ("ops at acme dot
 * com" → ops@acme.com), so chat text, transcript and card agree with the
 * draft; the speech layer spells it for the caller (ai/tts/speakable-text.ts).
 * Every other customer field is spoken as given.
 */
function customerFieldValue(key: string, value: string): string {
  return key === 'updatedEmail' ? normalizeSpokenEmail(value) : value;
}

const CUSTOMER_FIELDS_EN: ReadonlyArray<[string, string]> = [
  ['updatedName', 'name'],
  ['updatedPhone', 'phone number'],
  ['updatedEmail', 'email'],
  ['updatedAddress', 'address'],
];

function leadEn(e: Entities): string {
  const lead = text(e, 'leadReference') ?? text(e, 'customerName');
  return lead ? `the ${lead} lead` : 'that lead';
}

const CHANNEL_EN: Record<string, string> = { email: 'email', sms: 'text' };

/** " for Dana Reyes" / " for the Johnson job" / "" — the customer wins over a job. */
function forWhom(e: Entities, prep = ' for '): string {
  return suffix(prep, text(e, 'customerName') ?? text(e, 'jobReference'));
}

/** Spoken list: "a, b and c". */
function list(values: string[], and: string): string | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(', ')} ${and} ${values[values.length - 1]}`;
}

function items(e: Entities, and: string): string | undefined {
  const raw = e.lineItemDescriptions;
  const values = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
    : [];
  return list(values, and);
}

/** A booking reads back its time — or says it has none yet (#1538's copy problem). */
function scheduleEn(what: string, e: Entities): string {
  const when = text(e, 'dateTimeDescription');
  return `schedule ${what}${suffix(' for ', text(e, 'customerName'))}${
    when ? `, ${when}` : ', with no day or time yet'
  }`;
}

// ── Spanish (usted register, matching the rest of the es catalog) ──

const PAID_ES: Record<string, string> = {
  cash: 'pagado en efectivo',
  check: 'pagado con cheque',
  card: 'pagado con tarjeta',
  card_external: 'pagado con tarjeta',
};

const CHANNEL_ES: Record<string, string> = { email: 'correo electrónico', sms: 'mensaje de texto' };

const CADENCE_ES: Record<string, string> = {
  monthly: 'mensual',
  quarterly: 'trimestral',
  twice_a_year: 'dos veces al año',
  annual: 'una vez al año',
};

const CUSTOMER_FIELDS_ES: ReadonlyArray<[string, string]> = [
  ['updatedName', 'el nombre'],
  ['updatedPhone', 'el teléfono'],
  ['updatedEmail', 'el correo electrónico'],
  ['updatedAddress', 'la dirección'],
];

/** " para Dana Reyes" / " para the Johnson job" / "". */
function paraQuien(e: Entities, prep = ' para '): string {
  return suffix(prep, text(e, 'customerName') ?? text(e, 'jobReference'));
}

/** " de Dana Reyes" — whose document it is. */
function deQuien(e: Entities): string {
  return suffix(' de ', text(e, 'customerName') ?? text(e, 'jobReference'));
}

function customerEs(e: Entities): string {
  return text(e, 'customerName') ?? 'el cliente';
}

function appointmentEs(e: Entities): string {
  const ref = text(e, 'appointmentReference');
  if (ref) return asObject(ref);
  const name = text(e, 'customerName');
  return name ? `la cita de ${name}` : 'su cita';
}

function technicianEs(e: Entities, fallback: string): string {
  return text(e, 'targetTechnicianName') ?? fallback;
}

function durationEs(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  const hours = h === 0 ? '' : `${h} hora${h === 1 ? '' : 's'}`;
  const mins = m === 0 ? '' : `${m} minuto${m === 1 ? '' : 's'}`;
  return [hours, mins].filter(Boolean).join(' ') || `${minutes} minutos`;
}

function scheduleEs(what: string, e: Entities): string {
  const when = text(e, 'dateTimeDescription');
  return `agendar ${what}${suffix(' para ', text(e, 'customerName'))}${
    when ? `, ${when}` : ', todavía sin día ni hora'
  }`;
}

const ES: Record<string, Phrase> = {
  // ── scheduling ──
  create_appointment: (e) => scheduleEs('una cita', e),
  create_booking: (e) => scheduleEs('una cita', e),
  schedule_inspection: (e) => {
    const kind = stripPrefix(text(e, 'jobTitle'), 'Inspection');
    return scheduleEs(kind ? `una inspección (${kind})` : 'una inspección', e);
  },
  // ── money ──
  apply_credit: (e) =>
    `aplicar un crédito${suffix(' de ', money(e))}${suffix(' para ', text(e, 'customerName'))}`,
  record_refund: (e) =>
    `registrar un reembolso${suffix(' de ', money(e))}${suffix(' para ', text(e, 'customerName'))}${suffix(
      ', ',
      PAID_ES[text(e, 'refundMethod') ?? ''],
    )}`,
  record_payment: (e) =>
    `registrar un pago${suffix(' de ', money(e))}${suffix(' de parte de ', text(e, 'customerName'))}${suffix(
      ', ',
      PAID_ES[text(e, 'paymentMethod') ?? ''],
    )}`,
  log_expense: (e) =>
    `registrar un gasto${suffix(' de ', money(e))}${suffix(' por ', text(e, 'expenseDescription'))}${suffix(
      ' en ',
      text(e, 'vendor'),
    )}${suffix(' en el trabajo ', text(e, 'jobReference'))}`,
  log_mileage: (e) => {
    const miles = num(e, 'mileageMiles');
    return `registrar ${miles !== undefined ? `${miles} millas` : 'el millaje'}${suffix(
      ' en el trabajo ',
      text(e, 'jobReference'),
    )}`;
  },
  // ── invoices & estimates ──
  create_invoice: (e) => `preparar una factura${paraQuien(e)}${suffix(': ', items(e, 'y'))}`,
  update_invoice: (e) => `actualizar la factura${deQuien(e)} con ${items(e, 'y') ?? 'los cambios'}`,
  issue_invoice: (e) => `emitir la factura${deQuien(e)}`,
  send_invoice: (e) =>
    `enviar la factura${deQuien(e)}${suffix(' por ', CHANNEL_ES[text(e, 'sendChannel') ?? ''])}`,
  batch_invoice: () => 'facturar todos sus trabajos terminados',
  send_payment_reminder: (e) =>
    `enviar un recordatorio de pago${suffix(' a ', text(e, 'customerName')) || suffix(' por ', text(e, 'jobReference'))}`,
  apply_late_fee: (e) => `agregar un cargo por mora${suffix(' de ', money(e))} a la factura${deQuien(e)}`,
  draft_estimate: (e) => `preparar un presupuesto${paraQuien(e)}${suffix(': ', items(e, 'y'))}`,
  update_estimate: (e) => `actualizar el presupuesto${deQuien(e)} con ${items(e, 'y') ?? 'los cambios'}`,
  send_estimate: (e) => `enviar el presupuesto${deQuien(e)}`,
  send_estimate_nudge: (e) => `dar seguimiento al presupuesto${deQuien(e)}`,
  // ── customers & leads ──
  create_customer: (e) => {
    const who = text(e, 'displayName') ?? text(e, 'customerName');
    return who ? `registrar a ${who} como nuevo cliente` : 'registrar un nuevo cliente';
  },
  update_customer: (e) => {
    const who = text(e, 'customerName');
    const changes = list(
      CUSTOMER_FIELDS_ES.flatMap(([key, label]) => {
        const v = text(e, key);
        return v ? [`${label}${who ? ` de ${who}` : ''} a ${customerFieldValue(key, v)}`] : [];
      }),
      'y',
    );
    return changes ? `actualizar ${changes}` : `actualizar los datos de ${who ?? 'el cliente'}`;
  },
  add_service_location: (e) => {
    const address = text(e, 'serviceAddress');
    return `agregar ${address ? `${address} como dirección de servicio` : 'una dirección de servicio'}${suffix(
      ' para ',
      text(e, 'customerName'),
    )}`;
  },
  convert_lead: (e) => `convertir ${leadEs(e)} en cliente`,
  mark_lead_lost: (e) => `marcar ${leadEs(e)} como perdido${suffix(': ', text(e, 'lostReason'))}`,
  // ── jobs, notes & time ──
  create_job: (e) => `abrir un nuevo trabajo${paraQuien(e)}${suffix(': ', text(e, 'jobTitle'))}`,
  update_job: (e) => `actualizar ${text(e, 'jobReference') ?? `el trabajo${suffix(' de ', text(e, 'customerName'))}`}`,
  emergency_dispatch: (e) =>
    `enviar una llamada de emergencia${paraQuien(e)}${suffix(': ', text(e, 'problemDescription'))}`,
  log_warranty_claim: (e) =>
    `registrar un reclamo de garantía${paraQuien(e)}${suffix(': ', stripPrefix(text(e, 'jobTitle'), 'Warranty'))}`,
  add_note: (e) => `agregar una nota${paraQuien(e)}${suffix(': ', text(e, 'noteBody'))}`,
  log_permit: (e) => {
    const permit = stripPrefix(text(e, 'noteBody'), 'PERMIT');
    return `registrar ${permit ? `el permiso ${permit}` : 'un permiso'}${paraQuien(e)}`;
  },
  log_time_entry: (e) => {
    const minutes = num(e, 'durationMinutes');
    return `registrar ${minutes !== undefined ? `${durationEs(minutes)} de trabajo` : 'tiempo de trabajo'}${suffix(
      ' en ',
      text(e, 'jobReference'),
    )}`;
  },
  // ── messages to the customer ──
  send_customer_message: (e) =>
    `enviar un ${text(e, 'customerMessageChannel') === 'email' ? 'correo electrónico' : 'mensaje de texto'} a ${customerEs(
      e,
    )}${suffix(': ', text(e, 'customerMessageBody'))}`,
  request_feedback: (e) => `pedirle una reseña a ${customerEs(e)}`,
  notify_delay: (e) => {
    const delay = num(e, 'delayMinutes');
    return `avisarle a ${customerEs(e)} que va ${delay !== undefined ? `${durationEs(delay)} ` : ''}tarde`;
  },
  // ── changes to an existing appointment ──
  reschedule_appointment: (e) =>
    `mover ${appointmentEs(e)}${suffix(' para ', text(e, 'newDateTimeDescription'))}`,
  cancel_appointment: (e) => `cancelar ${appointmentEs(e)}`,
  confirm_appointment: (e) => `confirmar ${appointmentEs(e)}`,
  reassign_appointment: (e) => `asignar a ${technicianEs(e, 'otro técnico')} a ${appointmentEs(e)}`,
  add_crew_member: (e) => `agregar a ${technicianEs(e, 'un miembro del equipo')} a ${appointmentEs(e)}`,
  remove_crew_member: (e) => `quitar a ${technicianEs(e, 'un miembro del equipo')} de ${appointmentEs(e)}`,
  // ── materials, price book, agreements & settings ──
  add_material: (e) => {
    const qty = num(e, 'materialQuantity');
    return `agregar ${text(e, 'materialDescription') ?? 'eso'}${qty !== undefined && qty > 1 ? `, cantidad ${qty},` : ''} a la lista de compras${suffix(
      ' para ',
      text(e, 'jobReference'),
    )}${suffix(', para ', text(e, 'materialNeededBy'))}`;
  },
  add_catalog_item: (e) =>
    `agregar ${text(e, 'catalogItemNewName') ?? 'un artículo'} a su lista de precios${suffix(
      ' a ',
      money(e, 'unitPriceCents'),
    )}`,
  update_catalog_item: (e) => {
    const item = text(e, 'catalogItemReference') ?? 'ese artículo de su lista de precios';
    const price = money(e, 'unitPriceCents');
    if (price) return `cambiar el precio de ${item} a ${price}`;
    const newName = text(e, 'catalogItemNewName');
    return newName ? `cambiar el nombre de ${item} a ${newName}` : `actualizar ${item}`;
  },
  create_change_order: (e) =>
    `crear una orden de cambio${paraQuien(e)}${suffix(': ', text(e, 'changeOrderDescription'))}${suffix(
      ', por ',
      money(e),
    )}`,
  create_service_agreement: (e) =>
    `inscribir a ${customerEs(e)} en ${text(e, 'serviceAgreementName') ?? 'un contrato de servicio'}${suffix(
      ', ',
      CADENCE_ES[text(e, 'serviceAgreementCadence') ?? ''],
    )}`,
  create_invoice_schedule: (e) =>
    `crear un plan de pagos${paraQuien(e)}${suffix(': ', text(e, 'scheduleDescription'))}`,
  respond_to_review: (e) => `responder a ${text(e, 'reviewReference') ?? 'esa reseña'}`,
  create_standing_instruction: (e) =>
    `guardar una regla permanente${suffix(': ', text(e, 'instructionText'))}`,
  update_brand_voice: (e) =>
    `actualizar la voz de su marca${suffix(': ', text(e, 'brandVoiceInstruction'))}`,
};

function leadEs(e: Entities): string {
  const lead = text(e, 'leadReference') ?? text(e, 'customerName');
  return lead ? `el prospecto ${lead}` : 'ese prospecto';
}

/** The line for an intent with no phrase of its own (not a write intent). */
const DEFAULT_PHRASE: Record<SessionLanguage, string> = {
  en: 'take care of that request',
  es: 'atender su solicitud',
};

/** The readback phrase for `intent`, completing "you'd like to …" / "usted desea …". */
export function intentReadbackPhrase(
  intent: string | undefined,
  entities: Entities | undefined,
  lang: SessionLanguage,
): string {
  const phrase = intent ? (lang === 'es' ? ES : EN)[intent] : undefined;
  return phrase ? phrase(entities ?? {}) : DEFAULT_PHRASE[lang];
}
