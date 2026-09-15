/**
 * ANS-001 — caller-safety tier classification for the S1 answering surface.
 *
 * The inbound agent must route a hazard by its LIFE-SAFETY nature, not by a
 * single binary "is this an emergency" bit. This maps a caller utterance onto
 * the goal's three tiers:
 *
 *   E1 = life safety (gas/CO/fire/smoke/electrical/injury) — evacuate/911; NEVER book
 *   E2 = urgent (flooding/burst/sewage/no-heat-in-cold/no-cool/…) — dispatcher / same-day
 *   E3 = routine — normal booking flow
 *
 * DESIGN — why the E1 table is embedded in code (not loaded from
 * corpus/data/triage-rules.json):
 *   The runtime Docker image ships ONLY packages/api/dist; the corpus data
 *   file is not present at runtime. A life-safety classifier must never depend
 *   on loading an absent file, so the E1 table lives in code here — mirroring
 *   emergency-detector.ts, which already embeds its keyword table for exactly
 *   this reason. The richer `classifyUrgencyTier` engine (+ triage-rules.json)
 *   stays available as an OPTIONAL enrichment (`rules` arg) for tests, eval,
 *   and any environment that bundles the corpus; the embedded set is
 *   authoritative at runtime.
 *
 * Load-bearing invariant (goal §3 — "Any ambiguity resolves upward in tier,
 * always. A false positive costs one unnecessary transfer. A false negative
 * can cost a life."): the final tier is the MAX of every signal. A keyword hit
 * can be upgraded to E1 but is never downgraded below E2 by a guard.
 */
import {
  classifyUrgencyTier,
  type UrgencyContext,
} from '../../skills/classify-urgency-tier';
import type { TriageRules } from '../../skills/triage-rules.schema';
import { detectEmergency, type EmergencyLanguage } from './emergency-detector';

export type SafetyTier = 'E1' | 'E2' | 'E3';

/**
 * PLACEHOLDER E1 script — NOT deployment-final. Goal §3 is categorical: the
 * actual words spoken to a caller reporting a gas leak must be sourced by
 * someone with trade + legal standing, "not by us, and not by a model." This
 * string exists only so the ROUTING is testable end to end; it leads with the
 * universal 911 direction as a fail-safe interim.
 *
 * The injection seam for the reviewed script is the `responseScript` field on
 * the `emergency_detected` event: a per-tenant reviewed script (from voice
 * config) is passed there and overrides this default with no code change.
 * Deployment tooling should gate on `E1_SCRIPT_REVIEW_REQUIRED`.
 *
 * #1056 — there is NO Spanish E1 script. A Spanish hazard report is E1 and
 * hears THIS script (911 first, then the evacuation direction) and the call
 * hangs up: safer than the E2 dispatcher hand-off it used to get. The Spanish
 * text must be sourced with the same standing (decision O-2), not written here.
 * #1220 review — a Spanish caller first hears the already-catalogued Spanish
 * 911 line (the FSM's E1 branch in transitions.ts), then this script.
 */
export const LIFE_SAFETY_E1_SCRIPT =
  'If anyone is in immediate danger, hang up and call 911 now. ' +
  'If you smell gas or suspect carbon monoxide, please leave the building ' +
  'immediately without using light switches or your phone inside, then call ' +
  '911 and your gas company once you are safely outside. ' +
  "I'm flagging this for immediate follow-up.";

/**
 * TRUE until a qualified-review E1 script is sourced and wired per tenant.
 * A production readiness gate should assert this is handled (reviewed script
 * configured) before go-live — the routing is built; the words are not signed off.
 */
export const E1_SCRIPT_REVIEW_REQUIRED = true;

/**
 * Embedded E1 life-safety phrase table — the runtime-authoritative source.
 * Word-bounded to avoid substring false positives; bare "smoke"/"fire" are
 * deliberately excluded ("smoke detector low battery", "fireplace") in favour
 * of phrase-level triggers. Injury phrasing is intentionally broad — per the
 * goal an unnecessary transfer is cheap, a missed injury is not.
 */
/**
 * Acute physical hazards. These are E1 regardless of tense/framing — "there was
 * a gas leak" still warrants caution, and disambiguating tense on a gas/fire
 * report is not worth the risk of a miss.
 */
export const E1_HAZARD_PHRASES: ReadonlyArray<string> = [
  // Gas
  'smell gas', 'smells like gas', 'gas smell', 'rotten eggs', 'sulfur smell',
  'gas leak', 'leaking gas',
  // Carbon monoxide
  'carbon monoxide', 'co detector', 'co alarm',
  // Fire / smoke (phrase-level — bare "fire"/"smoke"/"flames" too ambiguous:
  // "the flames on my furnace are yellow" is a routine diagnostic call)
  'on fire', 'caught fire', 'house fire', 'there is a fire', "there's a fire",
  'seeing flames', 'there are flames', 'smell smoke', 'smells like smoke',
  'smoke coming', 'smoke in the house', 'full of smoke', 'filling with smoke',
  // Electrical
  'electrical burning', 'burning wires', 'wires are burning', 'burning plastic',
  'sparking', 'sparks coming', 'outlet is sparking', 'panel is sparking',
  'breaker is sparking', 'wires sparking', 'sparks from', 'sparks near',
];

/**
 * #1056 — Spanish acute hazards, category for category with
 * {@link E1_HAZARD_PHRASES}. Before this table a Spanish gas leak only hit the
 * `detectEmergency` backstop, which is E2: the caller got the dispatcher line,
 * the call stayed open and a drafted booking stayed live.
 *
 * Every entry names a hazard, like the English table. Bare
 * "fuego"/"humo"/"llamas"/"chispas"/"incendio" are left out:
 * - "las llamas del calentador están amarillas" is a routine diagnostic call.
 * - "la alarma de incendio" is an inspection.
 *
 * Entries are regex sources, not bare phrases, because Spanish needs three
 * things English word order gives the English table for free (#1220 review):
 * - Negation sits in front of the phrase: "no hay fuga de gas" contains
 *   "fuga de gas". Every entry is compiled behind {@link ES_NEGATION_GUARD}.
 * - Adjectives follow the noun: "veo llamas amarillas" is a flame-colour
 *   diagnostic, while English "seeing yellow flames" never contains
 *   "seeing flames". The flame-colour exception is `routineWhen`; pilot,
 *   burner and chimney exceptions are lookaheads on the entry.
 * - Accents: `[oó]` covers the unaccented form STT often returns.
 *
 * `routineWhen` names an utterance-level exception (see
 * {@link isSpanishRoutineContext}): igniter sparks and CO-detector install work
 * are routine trade calls. An E1 false positive hangs up on the customer.
 *
 * Open for bilingual trade sign-off (listed on the #1220 follow-up PR):
 * "huele a quemado" is E1 while "olor a quemado" stays on the E2 backstop,
 * the same as English "burning smell". Water that smells of rotten eggs or
 * sulfur stays E1, the same as English "rotten eggs" / "sulfur smell".
 */
export interface SpanishHazardPattern {
  /** Canonical phrase stamped on the audit row. */
  readonly keyword: string;
  /** Regex source, matched case-insensitively between Unicode word edges. */
  readonly pattern: string;
  readonly routineWhen?:
    | 'igniter_sparks'
    | 'co_device_request'
    | 'flame_colour'
    | 'gas_price_or_sale'
    | 'benign_smoke';
  /**
   * The phrase carries its own "no" ("no puedo apagar el fuego"): it is an
   * emergency, so it is compiled WITHOUT the negation guard — "no, no puedo
   * apagar el fuego" (comma dropped by STT) must stay E1.
   */
  readonly carriesNegation?: true;
}

const HUELE_INTENSITY = '(?:(?:mucho|muy fuerte|fuerte|bastante|demasiado|como) )?';
const NOT_CHIMNEY = '(?! (?:de|por) (?:la |mi )?chimenea)';
/**
 * English "sale" is a discount: "on sale gas water heaters", "yard sale gas
 * line", "sale gas prices". These grammatical exclusions apply to the BARE
 * "sale gas" phrase only, never to leak grammar. Price words elsewhere and
 * English sentences are the `gas_price_or_sale` suppressor, gated on the leak
 * signal.
 */
const NOT_ENGLISH_SALE =
  '(?<!(?<![\\p{L}\\p{N}])(?:on|for|the|any|big|yard|garage)\\s+(?:(?:se|le|les|me|te|nos)\\s+)?)';
const NOT_ENGLISH_GAS_NOUN =
  '(?! (?:water|heaters?|grills?|furnaces?|dryers?|ranges?|stoves?|ovens?|fireplaces?|generators?|appliances?|lines?|prices?|deals?|and|or)(?![\\p{L}\\p{N}]))';
/**
 * Third #1239 review: the ONLY price shape a preposition can open is "sale
 * (el gas) por/en/a <amount | currency | unit | bill>", as in "el propano sale
 * por tres dólares el galón", "¿cuánto le sale el gas al mes?" or "¿sale gas
 * en la factura?". Whatever else follows the preposition is where the gas is
 * coming from. Put after the preposition; the object must follow.
 */
const PREPOSITION_OBJECT_NOT_PRICE =
  '(?= \\S)(?! (?:(?:la|el|los|las|mi|su|un|una) )?(?:[\\p{N}$]|(?:uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|quinientos|mil|d[oó]lares|pesos|centavos|gal[oó]n|litros?|mes|semana|a[nñ]o|factura|recibo|cuenta|cobro|precio|oferta|barato|caro|m[aá]s)(?![\\p{L}\\p{N}])))';

export const E1_HAZARD_PATTERNS_ES: ReadonlyArray<SpanishHazardPattern> = [
  // Gas and propane
  { keyword: 'fuga de gas', pattern: 'fugas? de gas' },
  { keyword: 'escape de gas', pattern: 'escapes? de gas' },
  { keyword: 'fuga de propano', pattern: '(?:fugas?|escapes?) de propano' },
  { keyword: 'huele a gas', pattern: `huele ${HUELE_INTENSITY}a gas` },
  { keyword: 'huele a propano', pattern: `huele ${HUELE_INTENSITY}a propano` },
  { keyword: 'se huele gas', pattern: 'se huele (?:a )?(?:gas|propano)' },
  { keyword: 'olor a gas', pattern: 'olor (?:(?:muy )?(?:fuerte|intenso|raro) )?(?:a|de) (?:gas|propano)' },
  { keyword: 'huelo gas', pattern: `huelo ${HUELE_INTENSITY}(?:a )?(?:gas|propano)` },
  // Leak sense of "salir"/"escapar"/"botar", in every word order (#1234
  // re-review). An appliance is often the indirect object: "le sale gas a la
  // estufa", "me sale gas de la estufa".
  { keyword: 'está saliendo gas', pattern: '(?:se )?est[aá] saliendo (?:el )?(?:gas|propano)' },
  // LEAK GRAMMAR (third #1239 review): "(se|le|me…) sale/salen/salió/saliendo/
  // escapa/escapando (mucho) (el) gas de/del/por/en/a/al <source>". No
  // suppressor ever applies to it — not price, not English sentence, not
  // clause scope — and "cuánto/cómo" in front does not make it a price ("cómo
  // sale gas del tanque"). Only a price object after the preposition is
  // excluded (PREPOSITION_OBJECT_NOT_PRICE).
  {
    keyword: 'sale gas de',
    pattern: `(?:(?:se|le|les|me|te|nos) )?(?:sal(?:e|en|i[oó]|iendo)|escap(?:a|an|ando|[oó])) (?:(?:mucho|much[ií]simo|bastante|demasiado) )?(?:el )?(?:gas|propano) (?:de|del|por|en|a|al)${PREPOSITION_OBJECT_NOT_PRICE}`,
  },
  // Bare "sale gas" with no source ("se sale el gas", "nos sale gas", "sale el
  // gas"). Only here can price or English wording in the same clause suppress
  // it, and only when no leak or danger signal is present.
  {
    keyword: 'sale gas',
    pattern: `${NOT_ENGLISH_SALE}(?:(?:se|le|les|me|te|nos) )?sal(?:e|en|i[oó]|iendo) (?:(?:mucho|much[ií]simo|bastante|demasiado) )?(?:el )?(?:gas|propano)${NOT_ENGLISH_GAS_NOUN}`,
    routineWhen: 'gas_price_or_sale',
  },
  // "se" is optional on purpose: "no se escapa el gas" is STT's "no sé, se
  // escapa el gas" as often as a denial, and ties resolve upward.
  { keyword: 'se escapa el gas', pattern: '(?:se )?(?:est[aá] escapando|escapa|escap[oó]) (?:el )?(?:gas|propano)' },
  {
    keyword: 'el gas se escapa',
    pattern:
      `el (?:gas|propano) (?:se (?:est[aá] )?(?:escap(?:a|ando|[oó])|sal(?:e|iendo|i[oó]))|est[aá] (?:escapando|saliendo)|escap(?:a|[oó])|sal(?:e|i[oó]) (?:de|del|por|en|a|al)${PREPOSITION_OBJECT_NOT_PRICE})`,
  },
  { keyword: 'se siente el gas', pattern: 'se siente (?:(?:el|un) )?(?:gas|propano)' },
  { keyword: 'botando gas', pattern: 'bot(?:a|an|ando|[oó]) (?:el )?(?:gas|propano)' },
  { keyword: 'huevo podrido', pattern: 'huevos? podridos?' },
  { keyword: 'olor a azufre', pattern: '(?:olor|huele) a azufre' },
  // Carbon monoxide
  { keyword: 'monóxido de carbono', pattern: 'mon[oó]xido de carbono', routineWhen: 'co_device_request' },
  { keyword: 'detector de monóxido', pattern: '(?:detector|sensor) de (?:mon[oó]xido|co)', routineWhen: 'co_device_request' },
  { keyword: 'alarma de monóxido', pattern: 'alarma de (?:mon[oó]xido|co)', routineWhen: 'co_device_request' },
  { keyword: 'hay monóxido', pattern: 'hay mon[oó]xido' },
  // Fire and smoke
  { keyword: 'hay un incendio', pattern: '(?:hay|tenemos) un incendio' },
  { keyword: 'se incendió', pattern: 'se (?:incendi[oó]|est[aá] incendiando)' },
  { keyword: 'en llamas', pattern: 'en llamas' },
  { keyword: 'se prendió fuego', pattern: 'se (?:(?:le|les|me|nos) )?prendi[oó] (?:en )?fuego' },
  { keyword: 'agarró fuego', pattern: 'agarr[oó] fuego' },
  // A flame in the pilot or burner is how the appliance works.
  { keyword: 'hay fuego', pattern: 'hay fuego(?! en el (?:piloto|quemador))' },
  // "veo/hay llamas amarillas en el calentador" is a flame-colour diagnostic
  // (routineWhen). Flames coming OUT of something never are.
  { keyword: 'veo llamas', pattern: 'veo llamas', routineWhen: 'flame_colour' },
  { keyword: 'hay llamas', pattern: 'hay llamas(?! en el (?:piloto|quemador))', routineWhen: 'flame_colour' },
  { keyword: 'salen llamas', pattern: '(?:salen|saliendo) llamas' },
  // A coloured flame with a signal anywhere else ("llamas amarillas y me siento
  // mareado", "flama amarilla en el calentador y me duele la cabeza").
  {
    keyword: 'llamas amarillas',
    pattern: '(?:llamas?|flamas?) (?:de color )?(?:amarillas?|anaranjadas?|naranjas?|azul(?:es)?|rojas?)',
    routineWhen: 'flame_colour',
  },
  {
    keyword: 'no puedo apagar el fuego',
    pattern: 'no (?:puedo|podemos|puede|pueden|se puede) apagar (?:el )?(?:fuego|incendio)',
    carriesNegation: true,
  },
  {
    keyword: 'no me deja respirar el humo',
    pattern: '(?:el humo no (?:me|nos) deja respirar|no (?:me|nos) deja respirar el humo)',
    carriesNegation: true,
  },
  { keyword: 'huele a humo', pattern: '(?:huele|olor) a humo' },
  { keyword: 'sale humo', pattern: `(?:sale|salen|saliendo) humo${NOT_CHIMNEY}` },
  { keyword: 'humo saliendo', pattern: `humo saliendo${NOT_CHIMNEY}` },
  { keyword: 'humo en la casa', pattern: 'humo en (?:la|mi) casa' },
  {
    keyword: 'hay humo',
    pattern: 'hay humo(?! (?:saliendo )?(?:de|por|en) (?:la |mi )?chimenea)',
    routineWhen: 'benign_smoke',
  },
  { keyword: 'lleno de humo', pattern: 'llen(?:o|a|ando) de humo' },
  {
    keyword: 'se está quemando la casa',
    pattern: '(?:se (?:est[aá] quemando|quema) (?:la|mi) casa|(?:la|mi) casa se (?:est[aá] quemando|quema))',
  },
  // Electrical burning, short circuit and sparks
  { keyword: 'cables quemándose', pattern: 'cables quem[aá]ndose' },
  { keyword: 'se están quemando los cables', pattern: 'se est[aá]n quemando los cables' },
  { keyword: 'los cables se están quemando', pattern: 'cables se est[aá]n quemando' },
  { keyword: 'plástico quemado', pattern: 'pl[aá]stico quemado' },
  { keyword: 'huele a cable quemado', pattern: '(?:huele|olor) a cables? quemados?' },
  { keyword: 'huele a quemado', pattern: 'huele a quemado' },
  { keyword: 'cortocircuito', pattern: 'corto ?circuitos?' },
  {
    keyword: 'echando chispas',
    pattern: '(?:echando|echa|echan|saltan|saltando|salen|saliendo) chispas',
    routineWhen: 'igniter_sparks',
  },
  // Replaces the old "chispas del" / "chispas de la": sparks FROM an electrical
  // location, not "chispas de la estufa al prender" (the igniter).
  {
    keyword: 'chispas del enchufe',
    pattern:
      'chispas (?:del|de la|de los|de las|en el|en la) (?:enchufe|tomacorriente|contacto|panel|tablero|breaker|interruptor|cables?|caja de fusibles|medidor)',
    routineWhen: 'igniter_sparks',
  },
  { keyword: 'chispas cerca', pattern: 'chispas cerca', routineWhen: 'igniter_sparks' },
];

/** The Spanish E1 vocabulary as canonical phrases (audit keywords). */
export const E1_HAZARD_PHRASES_ES: ReadonlyArray<string> = E1_HAZARD_PATTERNS_ES.map(
  (entry) => entry.keyword,
);

/**
 * Injury / medical-event phrasing. E1 by default (broad on purpose — a missed
 * injury can cost a life), BUT suppressed when the report is CLEARLY past or
 * hypothetical with no present-tense urgency (see the guards below), so
 * "the old shed collapsed years ago" does not trigger a 911 direction. Anything
 * ambiguous stays E1 — the goal's asymmetric bias resolves upward.
 */
export const E1_INJURY_PHRASES: ReadonlyArray<string> = [
  'not breathing', "isn't breathing", 'is not breathing', 'stopped breathing',
  "won't wake up", 'not waking up', 'unconscious', 'unresponsive',
  'passed out', 'electrocuted', 'got shocked', 'electric shock',
  'someone is hurt', 'someone got hurt', "someone's hurt", 'somebody got hurt',
  'someone is injured', 'badly burned', 'severe burn', 'heart attack',
  'chest pain', 'chest pains', 'seizure',
];

/**
 * "collapsed" is a trade homonym ("my sewer line collapsed" is a routine,
 * high-value plumbing complaint) — an E1 false positive now costs the entire
 * call (911 script, hangup, booking revocation, owner emergency SMS), so the
 * bare word is not in the phrase table. It is E1 only with a person subject.
 */
const COLLAPSED_PERSON_RE =
  /\b(?:someone|somebody|anybody|he|she|they|my\s+(?:husband|wife|son|daughter|mom|dad|mother|father|kid|child|baby|brother|sister|friend|neighbor|roommate|tenant|grandma|grandpa|grandmother|grandfather|coworker|worker|guy|customer))\s+(?:(?:has|had|is|was|just)\s+){0,2}collapsed\b/i;

/**
 * #1221 — Spanish injury and medical emergencies, class for class with
 * {@link E1_INJURY_PHRASES}, plus the classes English lacks (severe bleeding,
 * choking, overdose, stroke, fell and cannot move, no pulse). Before this a
 * Spanish "inconsciente" was E3 and "no puedo respirar" only reached the E2
 * backstop.
 *
 * Same machinery as the Spanish hazard table: regex sources between Unicode
 * word edges, behind {@link ES_NEGATION_GUARD} ("no está inconsciente" is not
 * E1), NFC input. Phrases that carry their own "no" ("no puede respirar")
 * skip the guard, as #1239 established.
 *
 * Every entry has an `aspect` (#1245 review):
 * - 'state': a present symptom ("está inconsciente", "no respira", "tiene dolor
 *   en el pecho", "está sangrando", "se cayó y no se puede mover"). A state is
 *   NEVER downgraded, and one anywhere in the utterance keeps every other
 *   match live too: "mi papá está inconsciente, ayer estaba bien".
 * - 'event': a past-able event verb ("se desmayó", "se electrocutó", "tomó
 *   muchas pastillas"). Downgraded only when ITS OWN clause carries a past or
 *   hypothetical marker ({@link isSpanishClearlyPastEvent}).
 * - 'noun': a condition noun ("infarto", "sobredosis"). Its clause verb must
 *   also be past ("tuvo un infarto el año pasado").
 *
 * `idiomWhen` names a non-medical reading ("el precio es un infarto", "la bomba
 * se ahogó"). It applies only when nothing outside the matched words names a
 * person or a harm — the danger-first rule in reverse: "a mi papá le dio un
 * infarto" stays E1.
 *
 * Negation-risk and homonym review, for the bilingual medical/trade sign-off
 * (O-2, #1000):
 * - "no respira" is not E1 after a plumbing noun ("el drenaje no respira").
 * - "(me|le) dio un toque" needs electrical context. "le dio un toque final" is
 *   a finishing touch.
 * - "se quemó" needs a body part, "con aceite/agua hirviendo…", or a severity.
 *   "se me quemó la comida" is burned food.
 * - "se cayó" needs "y no se puede mover/levantar" or "y no se mueve/levanta".
 * - Device or price idioms: "no responde" (el termostato, el técnico…), "se
 *   ahoga" (la bomba, el motor…), "de infarto"/"infarto" (precio…),
 *   "desangrando" (precios…), "convulsiones/me duele el pecho de risa",
 *   "sobredosis de café".
 */
export interface SpanishInjuryPattern {
  /** Canonical phrase stamped on the audit row. */
  readonly keyword: string;
  /** Regex source, matched case-insensitively between Unicode word edges. */
  readonly pattern: string;
  /** The phrase carries its own "no"; compiled without the negation guard. */
  readonly carriesNegation?: true;
  /** Present symptom, past-able event verb, or condition noun (see above). */
  readonly aspect: 'state' | 'event' | 'noun';
  /** A non-medical reading, applied only without a person or harm signal. */
  readonly idiomWhen?: 'price' | 'laugh' | 'excess' | 'device';
  /**
   * A RECENT past report (ayer, anoche, hace N ≤ 7 días) still leaves a live
   * hazard: a shock yesterday means the outlet is still energised. Such a
   * report is E2 (same-day dispatch) instead of routine. Never applied when a
   * present symptom is also mentioned (that is E1).
   */
  readonly pastReportTier?: 'E2';
}

const ES_PERSON_NOUN =
  'pap[aá]|mam[aá]|padre|madre|espos[oa]|marido|mujer|hij[oa]s?|abuel[oa]s?|abuelit[oa]|beb[eé]s?|ni[nñ][oa]s?|herman[oa]s?|amig[oa]s?|vecin[oa]s?|t[ií][oa]s?|prim[oa]s?|suegr[oa]s?|compa[nñ]er[oa]s?|trabajador(?:es)?|se[nñ]or|se[nñ]ora|persona|paciente';
const ES_PERSON_SUBJECT = `(?:(?:mi|su|tu|el|la|nuestr[oa]) (?:${ES_PERSON_NOUN})|[eé]l|ella|alguien)`;
const ES_BODY_PART =
  '(?:manos?|brazos?|piernas?|cara|pies?|piel|dedos?|espalda|cuerpo|cuello|pecho|ojos?|cabeza|rodillas?)';
/** "(me|le) dio un toque" counts as a shock only with electrical context or at the end of the sentence. */
const ES_TOQUE_ELECTRICAL_CONTEXT =
  '(?= (?:el[eé]ctrico|de (?:corriente|luz|electricidad)|(?:el|la|un|una|mi) (?:enchufe|cable|tomacorriente|contacto|panel|breaker|interruptor|l[aá]mpara|foco|apagador|secadora|lavadora|refrigerador|calentador|boiler|medidor|caja)|con |cuando |al )|\\s*[.,;!?]|\\s*$)';

export const E1_INJURY_PATTERNS_ES: ReadonlyArray<SpanishInjuryPattern> = [
  // Unconscious / unresponsive (English: unconscious, unresponsive, passed out, won't wake up)
  { keyword: 'inconsciente', pattern: 'inconscientes?', aspect: 'state' },
  { keyword: 'desmayado', pattern: 'desmayad[oa]s?', aspect: 'state' },
  { keyword: 'se está desmayando', pattern: 'se (?:est[aá]n?) desmayando', aspect: 'state' },
  {
    keyword: 'se desmayó',
    pattern: 'se (?:(?:me|le|nos|les) )?(?:desmay[oó]|desmayaron|ha desmayado)',
    aspect: 'event',
  },
  {
    keyword: 'no responde',
    pattern: 'no (?:responde|reacciona|despierta|se despierta|abre los ojos)',
    carriesNegation: true,
    aspect: 'state',
    idiomWhen: 'device',
  },
  // Not breathing, no pulse (English: not breathing, stopped breathing)
  {
    keyword: 'no respira',
    pattern:
      '(?<!(?:drenaje|desag[uü]e|tuber[ií]a|tubo|ventilaci[oó]n|ca[nñ]o|pared|madera|motor|planta|tierra) )no (?:respira|est[aá] respirando)',
    carriesNegation: true,
    aspect: 'state',
    idiomWhen: 'device',
  },
  {
    keyword: 'no puede respirar',
    pattern: 'no (?:puede|puedo|podemos|pueden|puedes) respirar',
    carriesNegation: true,
    aspect: 'state',
  },
  { keyword: 'le cuesta respirar', pattern: '(?:me|le|te|nos|les) cuesta (?:mucho )?respirar', aspect: 'state' },
  { keyword: 'dejó de respirar', pattern: 'dej[oó] de respirar', aspect: 'event' },
  {
    keyword: 'no tiene pulso',
    pattern: 'no (?:tiene|tengo|le (?:encuentro|siento)|se le siente) (?:el )?pulso',
    carriesNegation: true,
    aspect: 'state',
  },
  // Chest pain / heart attack
  { keyword: 'dolor en el pecho', pattern: 'dolor (?:(?:muy )?fuerte )?(?:en el|del|de) pecho', aspect: 'state' },
  {
    keyword: 'me duele el pecho',
    pattern: '(?:me|le|te|nos|les) duele (?:(?:mucho|much[ií]simo|bastante|fuerte) )?el pecho',
    aspect: 'state',
    idiomWhen: 'laugh',
  },
  { keyword: 'infarto', pattern: 'infartos?|paro card[ií]aco|ataque card[ií]aco', aspect: 'noun', idiomWhen: 'price' },
  { keyword: 'ataque al corazón', pattern: 'ataque (?:al|del) coraz[oó]n', aspect: 'noun' },
  // Severe bleeding
  {
    keyword: 'sangra mucho',
    pattern: '(?:sangra|sangrando) (?:mucho|much[ií]simo|bastante|demasiado|sin parar)',
    aspect: 'state',
  },
  { keyword: 'mucha sangre', pattern: '(?:mucha|much[ií]sima|bastante|demasiada) sangre', aspect: 'state' },
  {
    keyword: 'se está desangrando',
    pattern: '(?:se )?est[aá]n? desangrando|desangr[aá]ndo(?:se|me|te|nos)',
    aspect: 'state',
    idiomWhen: 'price',
  },
  { keyword: 'no para de sangrar', pattern: 'no (?:para|deja) de sangrar', carriesNegation: true, aspect: 'state' },
  // Electrocution / shock (English: electrocuted, got shocked, electric shock)
  {
    keyword: 'se electrocutó',
    pattern:
      'se (?:(?:me|le|nos|les) )?electrocut(?:[oó]|aron)|(?:me|te|nos) electrocut(?:[eé]|aste|amos)|electrocutad[oa]s?',
    aspect: 'event',
    pastReportTier: 'E2',
  },
  {
    keyword: 'le dio la corriente',
    pattern: '(?:me|le|les|nos|te) (?:dio|pas[oó]) la corriente|(?:me|le|les|nos|te) dio una descarga(?: el[eé]ctrica)?',
    aspect: 'event',
    pastReportTier: 'E2',
  },
  {
    keyword: 'me dio un toque',
    pattern: `(?:me|le|les|nos|te) dio (?:un )?toque(?: el[eé]ctrico)?${ES_TOQUE_ELECTRICAL_CONTEXT}`,
    aspect: 'event',
    pastReportTier: 'E2',
  },
  // Seizure
  {
    keyword: 'convulsión',
    pattern: 'convulsi[oó]n(?:es)?|ataque (?:epil[eé]ptico|de epilepsia)',
    aspect: 'noun',
    idiomWhen: 'laugh',
  },
  { keyword: 'convulsionando', pattern: 'convulsionando|convulsiona', aspect: 'state' },
  // Choking / drowning
  {
    keyword: 'se está ahogando',
    pattern: 'se (?:(?:est[aá]|me|le|nos) )?ahog(?:a|ando)|(?:est[aá] )?ahog[aá]ndose',
    aspect: 'state',
    idiomWhen: 'device',
  },
  { keyword: 'se ahogó', pattern: 'se (?:(?:me|le|nos) )?ahog[oó]', aspect: 'event', idiomWhen: 'device' },
  {
    keyword: 'atragantado',
    pattern: 'atragantad[oa]s?|se (?:est[aá] )?atragantando|se (?:(?:le|me) )?atraganta',
    aspect: 'state',
  },
  { keyword: 'se atragantó', pattern: 'se (?:(?:le|me) )?atragant[oó]', aspect: 'event' },
  // Overdose
  { keyword: 'sobredosis', pattern: 'sobredosis', aspect: 'noun', idiomWhen: 'excess' },
  {
    keyword: 'tomó muchas pastillas',
    pattern:
      '(?:se )?tom[oó] (?:muchas|demasiadas|un mont[oó]n de|todas las|un frasco de|una caja de) (?:pastillas|p[ií]ldoras|medicinas|medicamentos)',
    aspect: 'event',
  },
  // Stroke
  { keyword: 'derrame cerebral', pattern: 'derrame cerebral|ataque cerebral|embolia', aspect: 'noun' },
  { keyword: 'le dio un derrame', pattern: '(?:me|le|te|nos|les) dio un derrame', aspect: 'event' },
  {
    keyword: 'se le paralizó la cara',
    pattern:
      'se (?:le|me|te|nos) paraliz[oó] (?:la cara|el brazo|la pierna|el cuerpo|medio cuerpo|un lado|la mitad de la cara|la mitad del cuerpo)|(?:tiene|tengo) (?:la cara|medio cuerpo|un lado del cuerpo) paralizad[oa]',
    aspect: 'event',
  },
  // Fell and cannot move / get up
  {
    keyword: 'se cayó y no se puede mover',
    pattern:
      'se (?:cay[oó]|ha ca[ií]do|cayeron)(?: [^,.;!?]{1,40}?)? y (?:ya |todav[ií]a )?no se (?:(?:puede|pueden) (?:mover|levantar)|mueve|mueven|levanta|levantan)',
    aspect: 'state',
  },
  {
    keyword: 'no se puede levantar',
    pattern: `${ES_PERSON_SUBJECT} (?:ya |todav[ií]a )?no se (?:(?:puede|pueden) (?:mover|levantar)|mueve|levanta)`,
    carriesNegation: true,
    aspect: 'state',
  },
  // Burned, injury sense (English: badly burned, severe burn)
  {
    keyword: 'se quemó',
    pattern: `se (?:(?:me|le|te|nos|les) )?quem(?:[oó]|aron) (?:(?:la|el|los|las|su|sus|mi|mis) )?${ES_BODY_PART}`,
    aspect: 'event',
  },
  {
    keyword: 'se quemó con',
    pattern:
      'se (?:(?:me|le|te|nos|les) )?quem(?:[oó]|aron) con (?:agua (?:hirviendo|caliente)|aceite|vapor|fuego|gasolina|electricidad|la estufa|el horno|el calentador|la plancha)',
    aspect: 'event',
  },
  {
    keyword: 'quemaduras graves',
    pattern: 'quemaduras? (?:graves?|fuertes?|serias?|de (?:segundo|tercer) grado)|gravemente quemad[oa]s?',
    aspect: 'noun',
  },
  // Someone hurt (English: someone is hurt / injured)
  {
    keyword: 'está herido',
    pattern:
      'alguien (?:sali[oó]|result[oó]|qued[oó]) (?:(?:muy|gravemente) )?(?:herid[oa]|lastimad[oa])|est[aá]n? (?:(?:muy|gravemente|mal) )?(?:herid[oa]s?|lastimad[oa]s?)|(?:hay|tenemos) (?:(?:un|una|unos|varios|dos) )?heridos?|gravemente herid[oa]s?',
    aspect: 'state',
  },
];

/** The Spanish injury vocabulary as canonical phrases (audit keywords). */
export const E1_INJURY_PHRASES_ES: ReadonlyArray<string> = E1_INJURY_PATTERNS_ES.map((e) => e.keyword);

/** Kept for callers/tests that want the full E1 vocabulary. */
export const LIFE_SAFETY_E1_PHRASES: ReadonlyArray<string> = [
  ...E1_HAZARD_PHRASES,
  ...E1_HAZARD_PHRASES_ES,
  ...E1_INJURY_PHRASES,
  ...E1_INJURY_PHRASES_ES,
];

/** Clearly past / hypothetical framing — a non-acute injury report. */
const PAST_OR_HYPOTHETICAL_RE =
  /\b(?:years?|months?|weeks?|days?)\s+ago\b|\blast\s+(?:year|month|week)\b|\bused to\b|\bin the past\b|\bhistory of\b|\ba while (?:back|ago)\b|\bif\s+(?:someone|somebody|anyone|anybody)\b|\bwhat if\b/i;
/** Present-tense urgency that OVERRIDES a past/hypothetical marker → stays E1. */
const PRESENT_URGENCY_RE =
  /\b(?:now|just|right now|currently|happening|help|hurry|911)\b|\b(?:is|isn'?t|not)\s+breathing\b|\b(?:he|she|they|someone|somebody)(?:'s| is| just)\b/i;

function compile(phrases: ReadonlyArray<string>) {
  return phrases.map((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { keyword: kw, regex: new RegExp(`\\b${escaped}\\b`, 'i') };
  });
}
/**
 * #1220 review — immediate negation in front of a Spanish hazard phrase:
 * "no huele a gas", "no hay (una | ningún) fuga de gas", "no está saliendo
 * gas", "no se huele gas". Only the words directly in front count, so
 * "no sé si hay fuga de gas" stays E1. "no" must be a whole word, so "bueno
 * huele a gas" stays E1. A comma breaks it: "no, huele a gas" stays E1.
 *
 * Object pronouns count ("no le sale gas a la estufa" is a stove with no gas).
 * #1234 review — "se" is NOT a guard word: STT turns "no sé, hay fuego" into
 * "no se hay fuego", which must stay E1. The one exception is "no se huele",
 * which is a denial whatever the accent.
 */
const ES_NEGATION_GUARD =
  '(?<!(?<![\\p{L}\\p{N}])no\\s+(?:(?:hay|est[aá]n?|siento|tengo|tiene|noto|le|les|me|te|nos)\\s+)?(?:(?:un|una|ning[uú]n|ninguna)\\s+)?)' +
  '(?!(?<=(?<![\\p{L}\\p{N}])no\\s+se\\s+)huele)';

/** Unicode word edges: JS `\b` is ASCII-only, so "se incendió" would never match. */
function compileSpanish<T extends { pattern: string; carriesNegation?: true }>(
  entries: ReadonlyArray<T>,
): Array<T & { regex: RegExp }> {
  return entries.map((entry) => ({
    ...entry,
    regex: new RegExp(
      `(?<![\\p{L}\\p{N}])${entry.carriesNegation ? '' : ES_NEGATION_GUARD}(?:${entry.pattern})(?![\\p{L}\\p{N}])`,
      'iu',
    ),
  }));
}

// ─── #1239 review — suppressors consult ONE leak/danger gate first ──────────
//
// Design rule: a suppressor (price/bill/sale, English sentence, benign smoke,
// flame colour, igniter sparks, CO-device work) may turn a Spanish E1 match
// into "routine" ONLY when the rest of the utterance carries no leak or danger
// signal. Three review rounds in a row, a suppressor with its own short list
// downgraded a real emergency; the lists now live in one place, are broad, and
// are consulted before any suppressor-specific wording.

/**
 * A named gas source: where a leak comes from. A superset of every source list
 * on origin/main (third #1239 review) plus piloto, regulador, pipa, calentón.
 */
const SIGNAL_GAS_SOURCE =
  'medidor(?:es)?|boiler|caldera|secadora|tubos?|tuber[ií]as?|tanques?|cilindros?|estufas?|hornillas?|hornos?|quemador(?:es)?|cocina|calentador(?:es)?|calent[oó]n|llaves?|v[aá]lvulas?|mangueras?|conexi[oó]n|conexiones|l[ií]neas?|piso|parrillas?|asador|piloto|regulador(?:es)?|pipas?|stoves?|heaters?|furnaces?|tanks?|meters?|pipes?|burners?|ovens?|valves?|hoses?';
/** A leak verb or smell. */
const SIGNAL_LEAK =
  'sale|salen|saliendo|sali[oó]|escap\\p{L}*|fugas?|huele|huelo|olor|se siente|bot(?:a|an|ando|[oó])|smell\\p{L}*|leak\\p{L}*|hissing';
/**
 * Harm to people: CO symptoms, smoke inhalation, the whole house. Children
 * alone are not harm ("el cuarto de los niños"); "los niños tosen" is, through
 * the verb.
 */
const SIGNAL_HARM =
  'tos|toser|tosiendo|tosen|arden (?:los )?ojos|ardor|marea\\p{L}*|mareos?|duele (?:la )?cabeza|dolor de cabeza|n[aá]useas?|v[oó]mit\\p{L}*|sue[nñ]o|somnolient\\p{L}*|desmay\\p{L}*|ahog\\p{L}*|respir\\p{L}*|en toda la casa';
/**
 * Fire, smoke, explosion, CO or an alarm going off. A superset of main's
 * hazard-word and alarm-sounding lists.
 */
const SIGNAL_SPREAD =
  'se prendi[oó]|se prendieron|se quem[oó]|se quemaron|quem(?!ador)\\p{L}*|fuego|llamas?|flamas?|humo|incendi\\p{L}*|chispas?|explot\\p{L}*|mon[oó]xido|pared(?:es)?|cortinas?|cerca|techo|muebles?|sonando|suena|son[oó]|pitando|pita|pit[oó]|pitar|pitido|chillando|activ[oó]|activad[oa]|dispar[oó]';
/** Combustion indoors or enclosed (a CO risk): grill smoke in the garage. */
const SIGNAL_ENCLOSED =
  'adentro|dentro|garajes?|cuartos?|habitaci[oó]n|rec[aá]mara|s[oó]tanos?|cerrad[oa]s?|encerrad[oa]s?|indoors?|inside|basement|garage';

function signalRe(...lists: string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${lists.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}
/** Leak, harm, fire/smoke/CO/alarm: danger in any context. */
const DANGER_SIGNAL_RE = signalRe(SIGNAL_LEAK, SIGNAL_HARM, SIGNAL_SPREAD);
/** Danger, plus combustion indoors. */
const DANGER_OR_ENCLOSED_SIGNAL_RE = signalRe(SIGNAL_LEAK, SIGNAL_HARM, SIGNAL_SPREAD, SIGNAL_ENCLOSED);
/** Danger, combustion indoors, plus a named gas source. */
const LEAK_OR_DANGER_SIGNAL_RE = signalRe(
  SIGNAL_GAS_SOURCE,
  SIGNAL_LEAK,
  SIGNAL_HARM,
  SIGNAL_SPREAD,
  SIGNAL_ENCLOSED,
);

/**
 * The one gate every suppressor consults FIRST, on the utterance with its own
 * trigger words blanked out (see {@link withoutSpan}); any hit stands the
 * suppressor down.
 *
 * `scope` says which lists count:
 * - 'gas' (price/sale/English, flame colour): every list, including a named
 *   gas source ("sale gas del tanque, what do I do").
 * - 'combustion' (benign smoke): danger plus enclosed spaces, but not
 *   appliances.
 * - 'device' (igniter sparks, CO-device work): danger only. An appliance, a
 *   room or children are context there: "el encendedor de la estufa echa
 *   chispas pero no prende", "un detector en el cuarto de los niños".
 */
function hasLeakOrDangerSignal(text: string, scope: 'gas' | 'combustion' | 'device'): boolean {
  if (scope === 'device') return DANGER_SIGNAL_RE.test(text);
  if (scope === 'combustion') return DANGER_OR_ENCLOSED_SIGNAL_RE.test(text);
  return LEAK_OR_DANGER_SIGNAL_RE.test(text);
}

/** The utterance with the words a suppressor is judging blanked out. */
function withoutSpan(text: string, index: number, length: number): string {
  return `${text.slice(0, index)} ${text.slice(index + length)}`;
}

const CLAUSE_BREAK_RE = /[,.;:!?¿¡]|(?<![\p{L}\p{N}])(?:y|pero|porque|and|but|so)(?![\p{L}\p{N}])/giu;

/**
 * The clause around a match. A suppressor's own context (a price word, an
 * English sentence, a barbecue) must sit in the SAME clause as the phrase it
 * suppresses: "sale mucho gas, ¿cuánto cuesta la reparación?" is a leak and a
 * separate price question, and "sale gas, what do I do?" is a Spanish leak
 * report with an English question.
 */
function clauseAround(text: string, index: number, length: number): string {
  let start = 0;
  let end = text.length;
  for (const brk of text.matchAll(CLAUSE_BREAK_RE)) {
    const at = brk.index ?? 0;
    if (at + brk[0].length <= index) start = at + brk[0].length;
    else if (at >= index + length) {
      end = at;
      break;
    }
  }
  return text.slice(start, end);
}

const ES_IGNITER_RE =
  /(?<![\p{L}\p{N}])(?:encendedor(?:es)?|chispero|ignitor|igniter|electrodo)(?![\p{L}\p{N}])/iu;
const ES_ELECTRICAL_LOCATION_RE =
  /(?<![\p{L}\p{N}])(?:enchufes?|tomacorrientes?|contactos?|panel|tablero|breakers?|interruptor(?:es)?|cables?|fusibles?|medidor|cortocircuito)(?![\p{L}\p{N}])/iu;
const ES_CO_DEVICE_RE = /(?<![\p{L}\p{N}])(?:detector(?:es)?|alarmas?|sensor(?:es)?)(?![\p{L}\p{N}])/iu;
const ES_DEVICE_WORK_RE =
  /(?<![\p{L}\p{N}])(?:instalar|instalaci[oó]n|comprar|cambiar|reemplazar|poner|bater[ií]as?|pilas?|cotizaci[oó]n|precio|revisar|inspecci[oó]n|mantenimiento)(?![\p{L}\p{N}])/iu;
/** A sounding alarm or CO symptoms outrank any install/battery wording. */
const ES_ALARM_SOUNDING_RE =
  /(?<![\p{L}\p{N}])(?:sonando|suena|son[oó]|pitando|pita|pit[oó]|pitar|pitido|chillando|activ[oó]|activad[oa]|dispar[oó]|se prendi[oó]|mareos?|maread[oa]|dolor de cabeza|n[aá]useas)(?![\p{L}\p{N}])/iu;

/**
 * A flame-colour description: "(veo|hay) llamas amarillas (en el calentador)",
 * "flama azul en la estufa". Its span is what the flame-colour suppressor
 * blanks out before the signal gate, so "…, ¿está fuera de lo normal?" stays
 * routine while "… y me duele la cabeza" or "veo llamas rojas en la secadora"
 * (a dryer is a gas source, not a listed flame appliance) is E1.
 */
const ES_FLAME_COLOUR_RE =
  /(?<![\p{L}\p{N}])(?:(?:veo|hay|tiene|tengo) (?:unas? )?)?(?:llamas?|flamas?) (?:de color )?(?:amarillas?|anaranjadas?|naranjas?|azul(?:es)?|rojas?)(?: (?:en|de|del)(?: el| la| los| las| mi)? (?:calentador(?:es)?|boiler|caldera|estufas?|horno|quemador(?:es)?|piloto|hornillas?|calefacci[oó]n))?(?![\p{L}\p{N}])/iu;
/** Price or bill wording: "sale" as cost ("¿qué tan caro me sale el gas?", "¿a cómo sale el propano?"). */
const ES_PRICE_RE =
  /(?<![\p{L}\p{N}])(?:cu[aá]nto|a c[oó]mo|caro|car[ií]simo|barat\p{L}*|precios?|prices?|cuesta|cobr\p{L}*|factura|recibo|pag\p{L}*|al mes|mensual\p{L}*|d[oó]lares|pesos|centavos|gal[oó]n|tarifas?|deals?|discount\p{L}*)(?![\p{L}\p{N}])/iu;
/**
 * Words that exist only in English. Two or more make the sentence English, so
 * "sale" is a discount. One alone is code-switching and stays Spanish.
 */
const EN_ONLY_WORD_RE =
  /(?<![\p{L}\p{N}])(?:the|at|is|are|was|i|my|you|your|we|our|needs?|have|has|do|does|any|on|for|this|that|it|and|with|of|to|there|what|how|can|bought|buy|line)(?![\p{L}\p{N}])/giu;
/**
 * Smoke with an ordinary cause: the heating's first run of the season (heating
 * AND "por primera vez" in the clause), barbecue, cigarettes. "hay humo por
 * primera vez" alone is not a cause.
 */
const ES_BENIGN_SMOKE_RE =
  /(?<![\p{L}\p{N}])(?:calefacci[oó]n(?![\p{L}\p{N}]).*(?<![\p{L}\p{N}])por primera vez|por primera vez(?![\p{L}\p{N}]).*(?<![\p{L}\p{N}])calefacci[oó]n|carne asada|asados?|parrillas?|asador|barbacoa|fogata|cigarros?|cigarrillos?|incienso)(?![\p{L}\p{N}])/iu;
/** A quantity of gas is a leak, never a price: "sale mucho gas". */
const ES_GAS_QUANTITY_RE = /(?<![\p{L}\p{N}])(?:mucho|much[ií]simo|bastante|demasiado)(?![\p{L}\p{N}])/iu;

/**
 * Utterance-level routine exceptions for a matched Spanish entry. Each one
 * FIRST asks {@link hasLeakOrDangerSignal} about the utterance outside its own
 * trigger words, and stands down on any signal. Then:
 * - igniter_sparks: an igniter is named and no electrical location is.
 * - co_device_request: a detector/alarm is named with install, purchase or
 *   battery work, and nothing says it is sounding.
 * - flame_colour: the flame is described only by its colour (and appliance).
 * - gas_price_or_sale: price or bill wording, or two English-only words, in the
 *   same clause, and no quantity of gas ("mucho").
 * - benign_smoke: first heat, barbecue or cigarette smoke in the same clause.
 */
function isSpanishRoutineContext(
  kind: NonNullable<SpanishHazardPattern['routineWhen']>,
  transcript: string,
  match: RegExpExecArray,
): boolean {
  if (kind === 'flame_colour') {
    const flame = ES_FLAME_COLOUR_RE.exec(transcript);
    return (
      flame !== null && !hasLeakOrDangerSignal(withoutSpan(transcript, flame.index, flame[0].length), 'gas')
    );
  }
  const scope =
    kind === 'gas_price_or_sale' ? 'gas' : kind === 'benign_smoke' ? 'combustion' : 'device';
  if (hasLeakOrDangerSignal(withoutSpan(transcript, match.index, match[0].length), scope)) return false;
  const clause = clauseAround(transcript, match.index, match[0].length);
  switch (kind) {
    case 'igniter_sparks':
      return ES_IGNITER_RE.test(transcript) && !ES_ELECTRICAL_LOCATION_RE.test(transcript);
    case 'gas_price_or_sale':
      return (
        !ES_GAS_QUANTITY_RE.test(match[0]) &&
        (ES_PRICE_RE.test(clause) || (clause.match(EN_ONLY_WORD_RE)?.length ?? 0) >= 2)
      );
    case 'benign_smoke':
      return ES_BENIGN_SMOKE_RE.test(clause);
    case 'co_device_request':
      return (
        ES_CO_DEVICE_RE.test(transcript) &&
        ES_DEVICE_WORK_RE.test(transcript) &&
        !ES_ALARM_SOUNDING_RE.test(transcript)
      );
  }
}

const HAZARD_REGEXES = compile(E1_HAZARD_PHRASES);
const HAZARD_REGEXES_ES = compileSpanish(E1_HAZARD_PATTERNS_ES);
const INJURY_REGEXES = compile(E1_INJURY_PHRASES);
const INJURY_REGEXES_ES = compileSpanish(E1_INJURY_PATTERNS_ES);

/**
 * #1245 review — a past or hypothetical marker ("hace dos años", "de chico",
 * "qué pasa si"). It only ever applies to the CLAUSE of an event or noun match,
 * never utterance-wide. "desde ayer" / "desde hace" is ongoing, not past, and
 * "hace un rato" (minutes ago) is not past either.
 */
const ES_PAST_MARKER_RE =
  /(?<![\p{L}\p{N}])(?<!desde )(?:ayer|anoche|antier|anteayer|hace (?:(?:un|una|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|varios|varias|muchos|muchas|\d+) )?(?:d[ií]as?|semanas?|mes(?:es)?|a[nñ]os?|tiempo)|la semana pasada|el (?:mes|a[nñ]o) pasado|de (?:ni[nñ][oa]|chic[oa]|joven|peque[nñ][oa])|cuando era (?:ni[nñ][oa]|chic[oa]|joven)|si (?:alguien|alguno|alguna|una persona|un ni[nñ]o)|qu[eé] pasa si|en caso de)(?![\p{L}\p{N}])/iu;
/** A recent past (ayer, anoche, hace N ≤ 7 días): the only window for the E2 residual-hazard fallback. */
const ES_RECENT_PAST_RE =
  /(?<![\p{L}\p{N}])(?<!desde )(?:ayer|anoche|antier|anteayer|hace (?:un|una|dos|tres|cuatro|cinco|seis|siete|[1-7]) d[ií]as?)(?![\p{L}\p{N}])/iu;
/** A past verb for a condition noun's clause ("tuvo un infarto", "le dio una convulsión"). */
const ES_PAST_VERB_RE =
  /(?<![\p{L}\p{N}])(?:tuvo|tuve|tuvimos|tuvieron|tuviste|dio|dieron|fue|fueron|hubo|sufri[oó]|sufrieron|estuvo|estaba|ten[ií]a|hab[ií]a|pas[oó]|daba)(?![\p{L}\p{N}])|\p{L}{2,}ó(?![\p{L}\p{N}])/iu;
/** Present urgency or recurrence: no downgrade anywhere in the utterance. */
const ES_PRESENT_URGENCY_RE =
  /(?<![\p{L}\p{N}])(?:ahora|ahorita|todav[ií]a|sigue|siguen|hoy|ayuda|auxilio|r[aá]pido|urgente|911|ambulancia|emergencia|otra vez|de nuevo|nuevamente)(?![\p{L}\p{N}])/iu;

/** Idiom contexts for {@link SpanishInjuryPattern.idiomWhen}. */
const ES_INJURY_IDIOM_RE: Record<NonNullable<SpanishInjuryPattern['idiomWhen']>, RegExp> = {
  price:
    /(?<![\p{L}\p{N}])(?:precios?|costos?|caro|car[ií]simo|cuenta|factura|recibo|cobran|cobrar|cobro|de infarto|impuestos?|renta|tarifas?)(?![\p{L}\p{N}])/iu,
  laugh: /(?<![\p{L}\p{N}])(?:de (?:la )?risa|de tanto re[ií]r|re[ií]r|riendo)(?![\p{L}\p{N}])/iu,
  excess:
    /(?<![\p{L}\p{N}])de (?:caf[eé]|az[uú]car|chocolate|trabajo|informaci[oó]n|amor|televisi[oó]n|tele|redes|series|f[uú]tbol|estr[eé]s|realidad)(?![\p{L}\p{N}])/iu,
  device:
    /(?<![\p{L}\p{N}])(?:bomba|motor|calentador|boiler|caldera|planta|generador|carro|coche|m[aá]quina|compresor|carburador|equipo|termostato|control|pantalla|tel[eé]fono|celular|app|aplicaci[oó]n|sistema|aparato|aire|minisplit|estufa|horno|lavadora|secadora|refrigerador|breaker|interruptor|panel|sensor|detector|alarma|puerta|port[oó]n|timbre|focos?|l[aá]mparas?|bombillas?|luz|luces|computadora|laptop|tablet|televisi[oó]n|tele|router|m[oó]dem|internet|wifi|t[eé]cnico|plomero|electricista|oficina|empresa|compa[nñ][ií]a|mensajes?|llamadas?|correos?|whatsapp)(?![\p{L}\p{N}])/iu,
};
/**
 * A person, a harm, or how someone got hurt (touched a live wire, fell): an
 * idiom reading never applies with one. "tocó el foco y no responde" is E1.
 */
const ES_PERSON_OR_HARM_RE = new RegExp(
  // "él" only with its accent: unaccented "el" is the article in every sentence.
  `(?<![\\p{L}\\p{N}])(?:${ES_PERSON_NOUN}|él|ella|alguien|${SIGNAL_HARM}|inconscien\\p{L}*|desmay\\p{L}*|pecho|sangr\\p{L}*|desangr\\p{L}*|convuls\\p{L}*|pulso|herid[oa]s?|lastimad[oa]s?|golpe\\p{L}*|duele|dolor|paraliz\\p{L}*|pastillas|ambulancia|911|toc[oó]|tocar|toque|corriente|descarga|electrocut\\p{L}*|chispa\\p{L}*|cay[oó]|ca[ií]do|ca[ií]da|hospital|cl[ií]nica|m[eé]dicos?|doctor(?:a|es)?|param[eé]dicos?|urgencias)(?![\\p{L}\\p{N}])`,
  'iu',
);

type InjuryHit = (typeof INJURY_REGEXES_ES)[number] & { match: RegExpExecArray };

/** Every Spanish injury entry that matches and is not an idiom reading. */
function spanishInjuryHits(transcript: string): InjuryHit[] {
  const hits: InjuryHit[] = [];
  for (const entry of INJURY_REGEXES_ES) {
    const match = entry.regex.exec(transcript);
    if (!match) continue;
    if (entry.idiomWhen) {
      // The idiom context must share the clause ("el precio es un infarto"); a
      // person or harm anywhere else keeps the medical reading.
      const clause = clauseAround(transcript, match.index, match[0].length);
      const clauseRest = clause.replace(match[0], ' ');
      const rest = withoutSpan(transcript, match.index, match[0].length);
      if (ES_INJURY_IDIOM_RE[entry.idiomWhen].test(clauseRest) && !ES_PERSON_OR_HARM_RE.test(rest)) continue;
    }
    hits.push({ ...entry, match });
  }
  return hits;
}

/**
 * True only for an event or noun match whose OWN clause is past or
 * hypothetical (a noun's clause verb must be past too), with no present
 * urgency and no danger signal anywhere else. A state is never past. Callers
 * must also check that no state matched anywhere.
 */
function isSpanishClearlyPastEvent(transcript: string, hit: InjuryHit): boolean {
  if (hit.aspect === 'state') return false;
  const clause = clauseAround(transcript, hit.match.index, hit.match[0].length);
  if (!ES_PAST_MARKER_RE.test(clause)) return false;
  if (hit.aspect === 'noun' && !ES_PAST_VERB_RE.test(clause)) return false;
  if (ES_PRESENT_URGENCY_RE.test(transcript)) return false;
  return !hasLeakOrDangerSignal(withoutSpan(transcript, hit.match.index, hit.match[0].length), 'device');
}

/** #1221/#1245 — the Spanish injury verdict: an E1 keyword, a recent-past E2 keyword, or neither. */
function classifySpanishInjury(transcript: string): { e1?: string; residualE2?: string } {
  const hits = spanishInjuryHits(transcript);
  if (hits.length === 0) return {};
  const state = hits.find((h) => h.aspect === 'state');
  if (state) return { e1: state.keyword };
  const live = hits.find((h) => !isSpanishClearlyPastEvent(transcript, h));
  if (live) return { e1: live.keyword };
  const recent = hits.find(
    (h) =>
      h.pastReportTier === 'E2' &&
      ES_RECENT_PAST_RE.test(clauseAround(transcript, h.match.index, h.match[0].length)),
  );
  return recent ? { residualE2: recent.keyword } : {};
}

/** Pure, synchronous, free — the embedded E1 life-safety scan. */
export function detectLifeSafetyE1(
  transcript: string,
): { matched: boolean; keyword?: string; language?: EmergencyLanguage } {
  // Acute hazards: always E1.
  for (const { keyword, regex } of HAZARD_REGEXES) {
    if (regex.test(transcript)) return { matched: true, keyword, language: 'en' };
  }
  for (const { keyword, regex, routineWhen } of HAZARD_REGEXES_ES) {
    const match = regex.exec(transcript);
    if (!match) continue;
    if (routineWhen && isSpanishRoutineContext(routineWhen, transcript, match)) continue;
    return { matched: true, keyword, language: 'es' };
  }
  // Injury: E1 unless clearly past/hypothetical AND no present-tense urgency.
  const clearlyNonAcute =
    PAST_OR_HYPOTHETICAL_RE.test(transcript) && !PRESENT_URGENCY_RE.test(transcript);
  if (!clearlyNonAcute) {
    for (const { keyword, regex } of INJURY_REGEXES) {
      if (regex.test(transcript)) return { matched: true, keyword, language: 'en' };
    }
    if (COLLAPSED_PERSON_RE.test(transcript)) {
      return { matched: true, keyword: 'collapsed', language: 'en' };
    }
  }
  // #1221 — Spanish injury/medical: a present symptom is always E1; an event
  // is E1 unless its own clause is clearly past (#1245 review).
  const spanishInjury = classifySpanishInjury(transcript);
  if (spanishInjury.e1) return { matched: true, keyword: spanishInjury.e1, language: 'es' };
  return { matched: false };
}

/**
 * #1221 — a RECENT past Spanish report whose hazard is still live (a shock
 * yesterday: the outlet is still energised). Returns the keyword for an E2
 * candidate, else null. Only consulted when nothing classified E1.
 */
function detectSpanishResidualInjuryHazard(transcript: string): string | null {
  return classifySpanishInjury(transcript).residualE2 ?? null;
}

/**
 * FIX 10(iii) — embedded E2 urgent-dispatch phrase table. Same rationale as
 * the E1 table above: corpus/data/triage-rules.json's TIER_2/TIER_3 phrases
 * are NOT shipped in the runtime image, so without an embedded set they are
 * dead weight outside a test/eval run that passes `rules`. This is
 * deliberately NOT a full parity table with TIER_2/TIER_3 (those stay
 * broader by design) — it pins only the specific corpus additions that had
 * no runtime equivalent at all ("sewage is backing up into the house" and a
 * fully-out AC classified E3 before this). Word-bounded like the E1 table.
 */
export const E2_URGENT_PHRASES: ReadonlyArray<string> = [
  'sewage backing up',
  'sewage is backing up',
  'sewage backing up into',
  'ac is out',
  'ac is completely out',
  'air conditioner is out',
  'no cooling',
];
const E2_REGEXES = compile(E2_URGENT_PHRASES);

/** Pure, synchronous, free — the embedded E2 urgent-dispatch scan. */
export function detectEmbeddedE2(
  transcript: string,
): { matched: boolean; keyword?: string } {
  for (const { keyword, regex } of E2_REGEXES) {
    if (regex.test(transcript)) return { matched: true, keyword };
  }
  return { matched: false };
}

export interface SafetyClassification {
  /** E1 = life safety (evacuate, never book), E2 = urgent, E3 = routine. */
  tier: SafetyTier;
  /** True only for E1. Switches the response into evacuation/safety-direct mode. */
  requiresEvacuation: boolean;
  /** Primary phrase/keyword that drove the classification (audit, non-PII). */
  keyword: string;
  /** Reviewed spoken script for E1, else null. */
  responseScript: string | null;
  /** Which layer decided the final tier — for post-incident review. */
  source: 'embedded' | 'engine' | 'backstop' | 'none';
  /**
   * #1056 — the language of the matched phrase, when a phrase table decided
   * the tier. A Spanish phrase is the strongest sign the caller speaks Spanish.
   * It rides the E1 audit row so a follow-up knows the caller heard the
   * English script (no Spanish E1 script exists yet, O-2).
   */
  language?: EmergencyLanguage;
}

const RANK: Record<SafetyTier, number> = { E1: 3, E2: 2, E3: 1 };

export type { UrgencyContext };

/**
 * Classify a caller utterance's safety tier. `rules` is OPTIONAL — when
 * omitted (the runtime hot path) only the embedded E1 table + `detectEmergency`
 * backstop are used; when provided, the richer `classifyUrgencyTier` engine
 * (vulnerability/seasonal amplifiers, wider E2 recall) is consulted too. The
 * final tier is always the strongest signal (upward-only bias, goal §3).
 */
export function classifyCallerSafety(
  utterance: string,
  ctx: UrgencyContext,
  rules?: TriageRules,
): SafetyClassification {
  // #1220 review — compose decomposed accents ("mono\u0301xido") so the
  // accented table entries match whatever normalization STT delivers.
  const text = utterance.normalize('NFC');
  const e1 = detectLifeSafetyE1(text);
  const embeddedE2 = detectEmbeddedE2(text);
  const backstop = detectEmergency(text);
  const engine = rules ? classifyUrgencyTier({ utterance: text, context: ctx }, rules) : null;

  let engineTier: SafetyTier | null = null;
  if (engine) {
    switch (engine.tier) {
      case 'TIER_1_EVACUATE':
        engineTier = 'E1';
        break;
      case 'TIER_2_EMERGENCY_DISPATCH':
      case 'TIER_3_SAME_DAY_URGENT':
        engineTier = 'E2';
        break;
      case 'TIER_4_SCHEDULE':
        engineTier = 'E3';
        break;
      default:
        // AMBIGUOUS_NEEDS_CLARIFICATION — no escalation signal from the engine.
        engineTier = null;
    }
  }

  // Build the candidate signals and take the strongest (E1 > E2 > E3).
  const candidates: Array<{
    tier: SafetyTier;
    source: SafetyClassification['source'];
    keyword?: string;
    script?: string | null;
    language?: EmergencyLanguage;
  }> = [];
  if (e1.matched)
    candidates.push({
      tier: 'E1',
      source: 'embedded',
      keyword: e1.keyword,
      // #1056 — the backstop's detected language is carried into the E1
      // candidate: Spanish anywhere in the hit means a Spanish speaker.
      language: e1.language === 'es' || backstop.language === 'es' ? 'es' : e1.language,
    });
  if (engineTier === 'E1')
    candidates.push({
      tier: 'E1',
      source: 'engine',
      keyword: engine!.matchedPhrases[0],
      script: engine!.responseScript ?? null,
    });
  if (engineTier === 'E2')
    candidates.push({ tier: 'E2', source: 'engine', keyword: engine!.matchedPhrases[0] });
  if (embeddedE2.matched)
    candidates.push({
      tier: 'E2',
      source: 'embedded',
      keyword: embeddedE2.keyword,
      language: 'en',
    });
  const residualInjuryHazard = e1.matched ? null : detectSpanishResidualInjuryHazard(text);
  if (residualInjuryHazard)
    candidates.push({ tier: 'E2', source: 'embedded', keyword: residualInjuryHazard, language: 'es' });
  if (backstop.matched)
    candidates.push({
      tier: 'E2',
      source: 'backstop',
      keyword: backstop.keyword,
      ...(backstop.language ? { language: backstop.language } : {}),
    });
  if (engineTier === 'E3') candidates.push({ tier: 'E3', source: 'engine' });

  if (candidates.length === 0) {
    return {
      tier: 'E3',
      requiresEvacuation: false,
      keyword: 'unknown',
      responseScript: null,
      source: 'none',
    };
  }

  candidates.sort((a, b) => RANK[b.tier] - RANK[a.tier]);
  const winner = candidates[0]!;
  // E1 carries the same script whatever the language: there is no reviewed
  // Spanish E1 script (see LIFE_SAFETY_E1_SCRIPT, #1056). The Spanish 911
  // line that precedes it for a Spanish caller is added by the FSM.
  const responseScript =
    winner.tier === 'E1'
      ? (winner.script ?? LIFE_SAFETY_E1_SCRIPT)
      : (winner.script ?? null);

  return {
    tier: winner.tier,
    requiresEvacuation: winner.tier === 'E1',
    keyword: winner.keyword ?? 'unknown',
    responseScript,
    source: winner.source,
    ...(winner.language ? { language: winner.language } : {}),
  };
}

// ─── Boot-time readiness gate (FIX 10i) ───────────────────────────────────────

export interface E1ScriptReadiness {
  /** False while the embedded placeholder is still in effect (deployment gate). */
  ready: boolean;
  /** Prominent, human-readable status for a structured boot log. */
  message: string;
}

/**
 * Pure, synchronous boot-time readiness check. This is the ONE consumer of
 * `E1_SCRIPT_REVIEW_REQUIRED` — without it the constant was declared but
 * never read, so a placeholder life-safety script could ship to production
 * completely silently. `app.ts` calls this once at boot and logs the result;
 * per-tenant overrides ride `tenant_settings.e1_reviewed_script` (migration
 * 267) via the `emergency_detected.responseScript` seam — see
 * `runEmergencyScan` in `telephony/twilio-adapter.ts`.
 *
 * Deliberately pure/free of I/O so it can NEVER be the reason boot fails —
 * callers still wrap the call defensively, but this function itself cannot
 * throw.
 */
export function e1ScriptReadiness(): E1ScriptReadiness {
  if (!E1_SCRIPT_REVIEW_REQUIRED) {
    return {
      ready: true,
      message: 'E1 life-safety script has been marked reviewed (E1_SCRIPT_REVIEW_REQUIRED=false).',
    };
  }
  return {
    ready: false,
    message:
      'E1 life-safety script is an UNREVIEWED PLACEHOLDER (LIFE_SAFETY_E1_SCRIPT). ' +
      'It leads with a fail-safe 911 direction but has not been signed off by anyone with ' +
      'trade + legal standing. Configure a reviewed script per tenant via ' +
      'tenant_settings.e1_reviewed_script before go-live — every E1 call speaks the ' +
      'placeholder until then.',
  };
}
