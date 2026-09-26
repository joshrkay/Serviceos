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
  // #1253 round 3
  'stinks of gas', 'stinks like gas', 'smells bad like gas', 'reeks of gas',
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
 * #1241 item 4 — English gas reports that need grammar, not a fixed phrase:
 * gas coming out of something, a hissing tank/line, and a broken/struck line.
 * Like {@link E1_HAZARD_PHRASES} these are never suppressed by price wording
 * ("the gas line is broken, how much to fix it?" is a leak). Guards:
 * - "no gas coming out of the burner" (a no-gas complaint) is excluded by a
 *   negation lookbehind; "gas is not coming out" never matches the grammar.
 * - "gas line install/quote" has no break verb; "cut-off valve" is a part, so a
 *   break verb must not be followed by a hyphen.
 */
const EN_GAS = '(?:natural )?(?:gas|propane)';
const EN_GAS_PART = '(?:line|lines|pipe|pipes|piping|hose|tank|meter|valve|regulator|connection|fitting)';
const EN_GAS_BREAK = '(?:broken|broke|busted|burst|cracked|ruptured|severed|snapped|cut|damaged|punctured|hit|struck|nicked)';
const EN_OWNER = '(?:(?:the|a|my|our|their|his|her|that|this) )?';
export const E1_HAZARD_PATTERNS_EN: ReadonlyArray<{ keyword: string; pattern: string }> = [
  {
    keyword: 'gas coming out',
    pattern: `(?<!\\b(?:no|not|any|zero) )${EN_GAS} (?:is |was |keeps )?(?:coming|pouring|escaping|blowing|spewing|seeping|rushing|hissing|leaking)(?: out)? (?:of|from)\\b`,
  },
  { keyword: 'gas escaping', pattern: `(?<!\\b(?:no|not|any|zero) )${EN_GAS} (?:is |was )?(?:escaping|spewing|pouring out)` },
  {
    keyword: 'gas hissing',
    pattern: `${EN_GAS}(?: [a-z]+){0,2} (?:is |are |keeps |was |started |starts )?(?:hissing|whistling)|hiss(?:ing|es)?(?: (?:sound|sounds|noise|noises))? (?:from|at|near|by|in|coming from) ${EN_OWNER}${EN_GAS} ${EN_GAS_PART}`,
  },
  {
    keyword: 'gas line broken',
    pattern: `${EN_GAS} ${EN_GAS_PART} (?:is |are |was |were |got |has been |just |(?:is|was|got) (?:just )?)?${EN_GAS_BREAK}(?![\\w-])|${EN_GAS_BREAK} (?:into )?${EN_OWNER}${EN_GAS} ${EN_GAS_PART}\\b`,
  },
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
  /**
   * Josh's decision (#1241): a gas price question ("a cómo / cuánto (me/le)
   * sale el gas …") with no leak or harm signal is E2, not E1. Set on the
   * "sale gas" entries so that shape never produces E1 on its own; the E2
   * candidate comes from {@link detectSpanishGasPriceQuestion}.
   */
  readonly priceQuestion?: true;
}

const HUELE_INTENSITY =
  '(?:(?:mucho|muy fuerte|fuerte|bastante|demasiado|como|feo|bien feo|muy feo|raro|mal|horrible) )?';
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
/**
 * #1241 — a number is a price only with a currency after it ("tres dólares",
 * "$50", "50 pesos"). "sale gas por los dos lados" / "por 2 lados" is a leak.
 */
const PRICE_AMOUNT =
  '(?:\\$ ?\\p{N}|(?:\\p{N}+(?:[.,]\\p{N}+)?|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|quinientos|mil) (?:d[oó]lar(?:es)?|pesos?|centavos?|bucks))';
const PREPOSITION_OBJECT_NOT_PRICE =
  `(?= \\S)(?! (?:(?:la|el|los|las|mi|su|un|una) )?(?:${PRICE_AMOUNT}|(?:d[oó]lares|pesos|centavos|gal[oó]n|litros?|mes|semana|a[nñ]o|factura|recibo|cuenta|cobro|precio|oferta|barato|caro|m[aá]s)(?![\\p{L}\\p{N}])))`;

/**
 * #1253 review — the ONE gas-trouble lexicon: the #1241 leak patterns below are
 * built from these words, and the price-question guard and the bare "sale gas"
 * suppressor consult the same words (SIGNAL_GAS_TROUBLE), so a price question
 * that also says "está chiflando" or "se rompió la manguera" stays E1.
 */
const GAS_HISS_WORDS = 'chiflando|chifla|chiflido|chiflidos|silbando|silba|silbido|silbidos|goteando|gotea|goteo';
/** #1253 round 2 — gas that will not stop, stinks or escapes. */
const GAS_ESCAPE_WORDS =
  'no para|apesta|apestando|huele (?:feo|raro|fuerte|mal|horrible)|se sale|se escapa|no (?:(?:le|la|lo) )?(?:puedo|podemos|puede|pueden) cerrar|no (?:(?:le|la|se) )?cierra';
const GAS_BROKEN_WORDS =
  'rot[oa]s?|rompi[oó]|rompieron|quebrad[oa]s?|quebr[oó]|rajad[oa]s?|raj[oó]|picad[oa]s?|pic[oó]|suelt[oa]s?|solt[oó]|da[nñ]ad[oa]s?';

export const E1_HAZARD_PATTERNS_ES: ReadonlyArray<SpanishHazardPattern> = [
  // Gas and propane
  { keyword: 'fuga de gas', pattern: 'fugas? de gas' },
  { keyword: 'escape de gas', pattern: 'escapes? de gas' },
  { keyword: 'fuga de propano', pattern: '(?:fugas?|escapes?) de propano' },
  { keyword: 'huele a gas', pattern: `huele ${HUELE_INTENSITY}a gas` },
  { keyword: 'huele a propano', pattern: `huele ${HUELE_INTENSITY}a propano` },
  { keyword: 'se huele gas', pattern: 'se huele (?:a )?(?:gas|propano)' },
  { keyword: 'olor a gas', pattern: 'olor(?:cito|zote)? (?:(?:muy )?(?:fuerte|intenso|raro|feo) )?(?:a|de) (?:gas|propano)' },
  { keyword: 'apesta a gas', pattern: 'apest(?:a|aba|ando) (?:(?:mucho|bien|horrible) )?a (?:gas|propano)' },
  { keyword: 'chiflando gas', pattern: `(?:est[aá] )?(?:${GAS_HISS_WORDS}|botando|tirando) (?:el )?(?:gas|propano)` },
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
    priceQuestion: true,
  },
  // #1241 — sourceless reflexive "se sale / se salió el gas" is never a price
  // phrasing: leak grammar, nothing suppresses it.
  {
    keyword: 'se sale el gas',
    pattern: 'se (?:(?:me|le|nos|te|les) )?(?:sale|salen|sali[oó]|est[aá] saliendo) (?:el )?(?:gas|propano)',
  },
  // Bare "sale gas" with no source ("se sale el gas", "nos sale gas", "sale el
  // gas"). Only here can price or English wording in the same clause suppress
  // it, and only when no leak or danger signal is present.
  {
    keyword: 'sale gas',
    pattern: `${NOT_ENGLISH_SALE}(?:(?:se|le|les|me|te|nos) )?sal(?:e|en|i[oó]|iendo) (?:(?:mucho|much[ií]simo|bastante|demasiado) )?(?:el )?(?:gas|propano)${NOT_ENGLISH_GAS_NOUN}`,
    routineWhen: 'gas_price_or_sale',
    priceQuestion: true,
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
  // #1241 — more leak phrasings
  { keyword: 'gas saliendo', pattern: '(?:gas|propano) (?:est[aá] )?saliendo (?:de|del|por)' },
  {
    keyword: 'hay gas en el aire',
    pattern:
      'hay (?:mucho )?(?:gas|propano) en (?:el aire(?! acondicionado)|el ambiente|la casa|toda la casa|la cocina|el cuarto|el s[oó]tano)',
  },
  {
    keyword: 'gas está chiflando',
    pattern: `(?:gas|propano)(?: [\\p{L}]+){0,2} (?:est[aá] )?(?:${GAS_HISS_WORDS})`,
  },
  {
    keyword: 'tubería de gas rota',
    pattern:
      `(?:manguera|tuber[ií]a|tubo|l[ií]nea|conexi[oó]n|v[aá]lvula|regulador) (?:del?|de la) (?:gas|propano) (?:est[aá] |se )?(?:${GAS_BROKEN_WORDS})|se (?:${GAS_BROKEN_WORDS}) (?:la |el )?(?:manguera|tuber[ií]a|tubo|l[ií]nea|conexi[oó]n|v[aá]lvula|regulador) (?:del?|de la) (?:gas|propano)`,
  },
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

interface EnglishInjuryPattern {
  keyword: string;
  pattern: string;
  carriesNegation?: true;
}

/**
 * #1246 — English injury classes that require grammar rather than a bare-word
 * lookup. Bare `stroke`, `choked`, and `fell` are intentionally absent: those
 * forms also describe time, completed routine events, and fallen equipment.
 */
const E1_INJURY_PATTERNS_EN: ReadonlyArray<EnglishInjuryPattern> = [
  { keyword: "can't breathe", pattern: "(?:can(?:not|'t)|unable to)\\s+breathe", carriesNegation: true },
  {
    keyword: 'severe bleeding',
    pattern: "(?:severe\\s+bleeding|bleeding\\s+(?:severely|heavily|badly)|bleeding\\s+(?:will|won't)\\s+stop)",
  },
  { keyword: 'choking', pattern: 'choking' },
  { keyword: 'overdose', pattern: "(?:overdosed|overdosing|an?\\s+overdose)" },
  { keyword: 'stroke', pattern: "(?:(?:is\\s+)?having|has|had)\\s+(?:a\\s+)?stroke" },
  {
    keyword: "fell and can't move",
    pattern:
      "(?:someone|somebody|he|she|they|my\\s+(?:husband|wife|son|daughter|mom|dad|mother|father|kid|child|baby|brother|sister|friend|neighbor|roommate|tenant|grandma|grandpa|grandmother|grandfather|coworker|worker|customer))\\s+(?:(?:has|had|just)\\s+)?(?:fell|fallen)\\b.{0,40}\\b(?:can(?:not|'t)|unable to)\\s+move",
    carriesNegation: true,
  },
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
  /**
   * Non-medical readings. price / laugh / excess / device apply only without a
   * person or harm signal; figurative ("herido de amor") and fiction ("una
   * película sobre alguien inconsciente") only without a harm signal, since
   * they always name a person.
   */
  readonly idiomWhen?: ReadonlyArray<
    | 'price'
    | 'laugh'
    | 'excess'
    | 'device'
    | 'device_subject'
    | 'unanswered'
    | 'figurative'
    | 'fiction'
    | 'pet'
    | 'stuck'
  >;
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
/** Things that fall on people (household objects plus structure and yard). */
const ES_FALLING_THING =
  'tele|televisi[oó]n|televisor|muebles?|escalera|cuadro|l[aá]mpara|repisa|estante|librero|espejo|ropero|refri|refrigerador|lavadora|secadora|estufa|horno|mesa|silla|puerta|ventana|techo|pared|barda|[aá]rbol|rama|poste|piedra|ladrillos?|viga|l[aá]mina|teja|reja|port[oó]n|tinaco|calentador|boiler|minisplit';
/** Heights someone falls from. */
const ES_HEIGHT =
  'escaleras?|escalones|segundo piso|tercer piso|un segundo piso|piso de arriba|techo|tejado|azotea|andamio|[aá]rbol|balc[oó]n|ventana|altura|barda';
/** "encima de / sobre / arriba de <a person>" (#1253 round 3). */
const ES_ON_A_PERSON = `(?:encima de(?:l| la| los| las| mi| mis| su| sus| tu)?|arriba de(?:l| la| mi| su)?|sobre(?: el| la| los| las| mi| mis| su| sus| tu)?) (?:${ES_PERSON_NOUN}|niñ[oa]s?|nena|nene|chiquit[oa]s?|chamaquit[oa]s?|criaturas?|él|ella|ellos|ellas|alguien)`;
/** A fall, or someone found on the floor. */
const ES_FALL =
  '(?:se (?:(?:me|le|nos) )?(?:cay[oó]|ha ca[ií]do|cayeron)|(?:l[oa]s?|le) encontr(?:[eé]|amos|aron) (?:tirad[oa]s?|en el (?:piso|suelo))|est[aá]n? tirad[oa]s?)';
/** Cannot move or get up: "no se puede mover/levantar/parar", "no se mueve", "no puede levantarse". */
const ES_CANNOT_GET_UP =
  'no (?:se (?:(?:puede|pueden) (?:mover|levantar|parar)|mueve|mueven|levanta|levantan|para|paran)|(?:puede|pueden) (?:moverse|levantarse|pararse))';
/** "(me|le) dio un toque" counts as a shock only with electrical context or at the end of the sentence. */
const ES_TOQUE_ELECTRICAL_CONTEXT =
  '(?= (?:el[eé]ctrico|de (?:corriente|luz|electricidad)|(?:el|la|un|una|mi) (?:enchufe|cable|tomacorriente|contacto|panel|breaker|interruptor|l[aá]mpara|foco|apagador|secadora|lavadora|refrigerador|calentador|boiler|medidor|caja)|con |cuando |al )|\\s*[.,;!?]|\\s*$)';

export const E1_INJURY_PATTERNS_ES: ReadonlyArray<SpanishInjuryPattern> = [
  // Unconscious / unresponsive (English: unconscious, unresponsive, passed out, won't wake up)
  { keyword: 'inconsciente', pattern: 'inconscientes?', aspect: 'state', idiomWhen: ['fiction'] },
  { keyword: 'desmayado', pattern: 'desmayad[oa]s?', aspect: 'state' },
  { keyword: 'se está desmayando', pattern: 'se (?:est[aá]n?) desmayando', aspect: 'state' },
  {
    keyword: 'se desmayó',
    pattern: 'se (?:(?:me|le|nos|les) )?(?:desmay[oó]|desmayaron|ha desmayado)',
    aspect: 'event',
    idiomWhen: ['device_subject'],
  },
  {
    keyword: 'se desvaneció',
    pattern: 'se (?:(?:me|le|nos) )?desvaneci[oó]',
    aspect: 'event',
    idiomWhen: ['device_subject'],
  },
  {
    keyword: 'se está desvaneciendo',
    pattern: 'se est[aá] desvaneciendo',
    aspect: 'state',
    idiomWhen: ['device_subject'],
  },
  {
    keyword: 'no responde',
    pattern: 'no (?:responde|contesta|reacciona|despierta|se despierta|abre los ojos)',
    carriesNegation: true,
    aspect: 'state',
    idiomWhen: ['device', 'unanswered'],
  },
  // Not breathing, no pulse (English: not breathing, stopped breathing)
  {
    keyword: 'no respira',
    pattern:
      '(?<!(?:drenaje|desag[uü]e|tuber[ií]a|tubo|ventilaci[oó]n|ca[nñ]o|pared|madera|motor|planta|tierra) )no (?:respira|est[aá] respirando)',
    carriesNegation: true,
    aspect: 'state',
    idiomWhen: ['device'],
  },
  {
    keyword: 'no puede respirar',
    pattern: 'no (?:puede|puedo|podemos|pueden|puedes) respirar',
    carriesNegation: true,
    aspect: 'state',
  },
  { keyword: 'le cuesta respirar', pattern: '(?:me|le|te|nos|les) cuesta (?:mucho )?respirar', aspect: 'state' },
  { keyword: 'le falta el aire', pattern: '(?:me|le|te|nos|les) falta (?:el )?aire', aspect: 'state' },
  {
    keyword: 'se está asfixiando',
    pattern: 'se (?:(?:est[aá]|me|le|nos) )?asfixi(?:ando|a)|asfixi[aá]ndose',
    aspect: 'state',
  },
  { keyword: 'se asfixió', pattern: 'se (?:(?:me|le|nos) )?asfixi[oó]', aspect: 'event' },
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
    idiomWhen: ['laugh'],
  },
  { keyword: 'infarto', pattern: 'infartos?|paro card[ií]aco|ataque card[ií]aco', aspect: 'noun', idiomWhen: ['price'] },
  { keyword: 'ataque al corazón', pattern: 'ataque (?:al|del) coraz[oó]n', aspect: 'noun' },
  // Severe bleeding
  {
    keyword: 'sangra mucho',
    pattern: '(?:sangra|sangrando) (?:mucho|much[ií]simo|bastante|demasiado|sin parar)',
    aspect: 'state',
  },
  { keyword: 'mucha sangre', pattern: '(?:mucha|much[ií]sima|bastante|demasiada) sangre', aspect: 'state' },
  {
    keyword: 'sangra de la cabeza',
    pattern:
      '(?:sangra|sangrando) (?:(?:mucho|much[ií]simo) )?(?:de|por) (?:la|el|su|los|las) (?:cabeza|boca|o[ií]dos?|ojos?|cuello|pecho|est[oó]mago|herida)',
    aspect: 'state',
  },
  { keyword: 'vomitando sangre', pattern: 'vomit(?:ando|a|[oó]) sangre|v[oó]mito con sangre', aspect: 'state' },
  {
    keyword: 'se está desangrando',
    pattern: '(?:se )?est[aá]n? desangrando|desangr[aá]ndo(?:se|me|te|nos)',
    aspect: 'state',
    idiomWhen: ['price'],
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
    keyword: 'se está electrocutando',
    pattern:
      'se (?:(?:me|le|nos) )?est[aá]n? electrocutando|electrocut[aá]ndose|(?:me|le|les|nos|te) est[aá] (?:dando|pasando) la corriente',
    aspect: 'state',
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
    idiomWhen: ['price'],
  },
  // Seizure
  {
    keyword: 'convulsión',
    pattern: 'convulsi[oó]n(?:es)?|ataque (?:epil[eé]ptico|de epilepsia)',
    aspect: 'noun',
    idiomWhen: ['laugh', 'price'],
  },
  { keyword: 'convulsionando', pattern: 'convulsionando|convulsiona', aspect: 'state' },
  // Choking / drowning
  {
    keyword: 'se está ahogando',
    pattern: 'se (?:(?:est[aá]|me|le|nos) )?ahog(?:a|ando)|(?:est[aá] )?ahog[aá]ndose',
    aspect: 'state',
    idiomWhen: ['device'],
  },
  { keyword: 'se ahogó', pattern: 'se (?:(?:me|le|nos) )?ahog[oó]', aspect: 'event', idiomWhen: ['device'] },
  {
    keyword: 'atragantado',
    pattern: 'atragantad[oa]s?|se (?:est[aá] )?atragantando|se (?:(?:le|me) )?atraganta',
    aspect: 'state',
  },
  { keyword: 'se atragantó', pattern: 'se (?:(?:le|me) )?atragant[oó]', aspect: 'event' },
  // Overdose
  { keyword: 'sobredosis', pattern: 'sobredosis', aspect: 'noun', idiomWhen: ['excess'] },
  // Poison, swallowed object, sting or bite with swelling
  {
    keyword: 'tomó veneno',
    pattern:
      '(?:se )?(?:tom[oó]|bebi[oó]|trag[oó]|comi[oó]|ingiri[oó]) (?:(?:el|la|los|las|un|una|un poco de|mucho|mucha|todo el|toda la) )?(?:veneno|cloro|lej[ií]a|blanqueador|thinner|tiner|gasolina|anticongelante|raticida|matarratas|insecticida|pesticida|destapacaños|destapacanos|sosa c[aá]ustica|[aá]cido|amon[ií]aco|detergente|limpiador)',
    aspect: 'event',
    idiomWhen: ['pet'],
  },
  { keyword: 'envenenado', pattern: 'envenenad[oa]s?|intoxicad[oa]s?', aspect: 'state' },
  { keyword: 'se envenenó', pattern: 'se (?:(?:me|le|nos) )?(?:envenen[oó]|intoxic[oó])', aspect: 'event' },
  {
    keyword: 'se tomó la medicina de otra persona',
    pattern: `(?:se )?(?:tom[oó]|trag[oó]) (?:la|las|el|los) (?:medicinas?|pastillas|p[ií]ldoras|medicamentos?|jarabe) (?:de|del) (?:(?:su|sus|mi|mis|tu|la|el|los|las) )?(?:${ES_PERSON_NOUN})`,
    aspect: 'event',
  },
  {
    keyword: 'se tragó una pila',
    pattern:
      'se (?:(?:me|le|te|nos) )?trag[oó] (?:(?:una|un|unas|unos|la|el|las|los) )?(?:pilas?|bater[ií]as?|monedas?|im[aá]n(?:es)?|imanes|clavos?|tornillos?|aretes?|anillos?|canicas?|botones?|alfileres?|vidrios?)',
    aspect: 'event',
    idiomWhen: ['pet'],
  },
  {
    keyword: 'picadura con hinchazón',
    pattern:
      '(?:me|le|te|nos|les) (?:pic[oó]|mordi[oó]) (?:un |una )?(?:alacr[aá]n|escorpi[oó]n|ara[nñ]a|abeja|avispa|v[ií]bora|serpiente|culebra|hormigas?|perro|gato)[^.;!?]{0,40}?(?:se (?:(?:le|me) )?est[aá] hinchando|se (?:(?:le|me) )?hinch[oó]|hinchad[oa]|inflamad[oa]|no puede respirar|le cuesta respirar)',
    aspect: 'state',
    idiomWhen: ['pet'],
  },
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
  // #1245 round 2: a comma or nothing instead of "y", "no puede levantarse",
  // "no se puede parar", "lo encontré tirado".
  {
    keyword: 'se cayó y no se puede mover',
    pattern: `${ES_FALL}[^.;!?]{0,60}?(?:,|\\sy)?\\s(?:ya |todav[ií]a )?${ES_CANNOT_GET_UP}`,
    aspect: 'state',
  },
  {
    keyword: 'no se puede levantar',
    pattern: `${ES_PERSON_SUBJECT} (?:ya |todav[ií]a )?${ES_CANNOT_GET_UP}`,
    carriesNegation: true,
    aspect: 'state',
  },
  // #1253 round 2, rule 6: a fall from height, something falling on someone, trapped.
  {
    keyword: 'se cayó de la escalera',
    pattern: `(?:(?:se (?:(?:me|le|nos) )?)?(?:cay[oó]|call[oó]|ha ca[ií]do|cayeron)|se (?:avent[oó]|tir[oó]|lanz[oó])) (?:de|del|desde|por) (?:(?:la|el|las|los|una|un|lo alto de la|lo alto del) )?(?:${ES_HEIGHT})|(?:se )?(?:cay[oó]|call[oó]) en las escaleras|(?:se )?rod[oó] (?:por|de) (?:las |la )?escaleras?`,
    aspect: 'event',
  },
  {
    keyword: 'se cayó a la alberca',
    pattern:
      '(?:se )?(?:cay[oó]|call[oó]|cayeron) (?:a|al|en) (?:(?:la|el) )?(?:alberca|piscina|pileta|pozo|r[ií]o|lago|canal|agua|cisterna|tinaco|mar|presa)',
    aspect: 'event',
    idiomWhen: ['pet'],
  },
  {
    keyword: 'en el fondo de la alberca',
    pattern: 'en el fondo de (?:la|el) (?:alberca|piscina|pileta|agua|r[ií]o|lago|pozo|cisterna)',
    aspect: 'state',
  },
  {
    keyword: 'se cayó encima de alguien',
    pattern: `(?:se (?:(?:le|me|nos|les) )?)?(?:cay[oó]|call[oó]|vino|derrumb[oó]|desplom[oó])(?: (?:el|la|los|las|un|una) (?:${ES_FALLING_THING}))? ${ES_ON_A_PERSON}|(?:el|la|los|las|un|una) (?:${ES_FALLING_THING}) (?:se )?(?:cay[oó]|call[oó]|vino|derrumb[oó]|desplom[oó]) ${ES_ON_A_PERSON}|se (?:le|me|nos|les) vino (?:encima|abajo)`,
    aspect: 'event',
  },
  { keyword: 'lo aplastó', pattern: '(?:lo|la|le|los|las|me|nos) aplast[oó]|qued[oó] aplastad[oa]', aspect: 'event' },
  {
    keyword: 'le cayó encima',
    pattern: `(?:se )?(?:le|me|les|nos) cay[oó] (?:encima|arriba)|(?:le|me|les|nos) cay[oó] (?:encima )?(?:el|la|los|las|un|una) (?:${ES_FALLING_THING})`,
    aspect: 'event',
  },
  {
    keyword: 'quedó atrapado',
    pattern:
      '(?:qued[oó]|quedaron|est[aá]n?|estamos) (?:atrapad|prensad|atorad|aplastad)[oa]s? (?:debajo|abajo|bajo|entre|dentro|adentro|en|con)',
    aspect: 'state',
    idiomWhen: ['pet', 'stuck'],
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
    idiomWhen: ['figurative'],
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
  /\b(?:years?|months?|weeks?|days?)\s+ago\b|\bearlier\b|\blast\s+(?:year|month|week)\b|\bused to\b|\bin the past\b|\bhistory of\b|\ba while (?:back|ago)\b|\bif\s+(?:someone|somebody|anyone|anybody)\b|\bwhat if\b/i;
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
  'tos|toser|tosiendo|tosen|arden (?:los )?ojos|ardor|mare[aoó]\\p{L}*|mareos?|duele (?:la )?cabeza|dolor de cabeza|n[aá]useas?|v[oó]mit\\p{L}*|sue[nñ]o|somnolient\\p{L}*|desmay\\p{L}*|ahog\\p{L}*|respir\\p{L}*|en toda la casa';
/**
 * Fire, smoke, explosion, CO or an alarm going off. A superset of main's
 * hazard-word and alarm-sounding lists.
 */
const SIGNAL_SPREAD =
  'se prendi[oó]|se prendieron|se quem[oó]|se quemaron|quem(?!ador)\\p{L}*|fuego|llamas?|flamas?|humo|incendi\\p{L}*|chispas?|explot\\p{L}*|mon[oó]xido|pared(?:es)?|cortinas?|cerca|techo|muebles?|sonando|suena|son[oó]|pitando|pita|pit[oó]|pitar|pitido|chillando|activ[oó]|activad[oa]|dispar[oó]';
/** #1253 review — gas trouble: hissing or a broken line (the shared lexicon of the #1241 patterns). */
const SIGNAL_GAS_TROUBLE = `${GAS_HISS_WORDS}|${GAS_BROKEN_WORDS}|${GAS_ESCAPE_WORDS}`;
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
  SIGNAL_GAS_TROUBLE,
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
  const { start, end } = clauseBounds(text, index, length);
  return text.slice(start, end);
}

/** Offsets of {@link clauseAround}'s clause. */
function clauseBounds(text: string, index: number, length: number): { start: number; end: number } {
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
  return { start, end };
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
  match: RegExpMatchArray,
): boolean {
  const ctx = scanContext(transcript);
  const index = match.index ?? 0;
  const end = index + match[0].length;
  if (kind === 'flame_colour') {
    const flame = ctx.flameColour.overlap(index, end) ?? ctx.flameColour.overlap(0, ctx.text.length);
    return flame !== null && !ctx.gasSignal.anyOutside(flame.start, flame.end);
  }
  const signal = kind === 'gas_price_or_sale' ? ctx.gasSignal : kind === 'benign_smoke' ? ctx.combustionSignal : ctx.danger;
  if (signal.anyOutside(index, end)) return false;
  const clause = clauseOf(ctx, index, end);
  switch (kind) {
    case 'igniter_sparks':
      return ctx.igniterOnly;
    case 'gas_price_or_sale':
      return (
        !ES_GAS_QUANTITY_RE.test(match[0]) &&
        (ctx.priceWords.anyWithin(clause.start, clause.end) || ctx.englishWords.countWithin(clause.start, clause.end) >= 2)
      );
    case 'benign_smoke':
      return benignSmokeShape(ctx, clause) !== null;
    case 'co_device_request':
      return ctx.coDeviceWork;
  }
}

/**
 * The benign cause of smoke in a clause, answered from span indexes (linear;
 * the old `.*` regexes were quadratic on a flood of "asador"): 'first_heat'
 * (heating + "por primera vez") and 'outdoor_cooking' are the two shapes
 * approved in #1239; 'other' (barbecue indoors or unspecified, cigarettes,
 * incense) is a heuristic reading capped at E2.
 */
function benignSmokeShape(
  ctx: ScanContext,
  clause: { start: number; end: number },
): 'first_heat' | 'outdoor_cooking' | 'other' | null {
  if (ctx.heating.anyWithin(clause.start, clause.end) && ctx.firstTime.anyWithin(clause.start, clause.end)) {
    return 'first_heat';
  }
  const cooking = ctx.cooking.anyWithin(clause.start, clause.end);
  if (cooking && ctx.outdoors.anyWithin(clause.start, clause.end)) return 'outdoor_cooking';
  if (cooking || ctx.otherSmokeCause.anyWithin(clause.start, clause.end)) return 'other';
  return null;
}

const HAZARD_REGEXES = [
  ...compile(E1_HAZARD_PHRASES),
  ...E1_HAZARD_PATTERNS_EN.map(({ keyword, pattern }) => ({ keyword, regex: new RegExp(`\\b(?:${pattern})`, 'i') })),
];
const HAZARD_REGEXES_ES = compileSpanish(E1_HAZARD_PATTERNS_ES).map((entry) => ({
  ...entry,
  regexAll: new RegExp(entry.regex.source, 'giu'),
}));
const INJURY_REGEXES = compile(E1_INJURY_PHRASES);
const INJURY_REGEXES_EN = E1_INJURY_PATTERNS_EN.map((entry) => ({
  ...entry,
  regex: new RegExp(`\\b(?:${entry.pattern})\\b`, 'i'),
}));
const INJURY_REGEXES_ES = compileSpanish(E1_INJURY_PATTERNS_ES).map((entry) => ({
  ...entry,
  regexAll: new RegExp(entry.regex.source, 'giu'),
}));

/**
 * #1245 review — a past or hypothetical marker ("hace dos años", "de chico",
 * "qué pasa si"). It only ever applies to the event verb it modifies, inside
 * that event's clause ({@link attachedPastMarker}), never utterance-wide. "desde ayer" / "desde hace" is ongoing, not past, and
 * "hace un rato" (minutes ago) is not past either.
 */
const ES_PAST_MARKER_RE =
  /(?<![\p{L}\p{N}])(?<!desde )(?:ayer|anoche|antier|anteayer|hace (?:(?:un|una|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|varios|varias|muchos|muchas|\d+) )?(?:d[ií]as?|semanas?|mes(?:es)?|a[nñ]os?|tiempo)|la semana pasada|el (?:mes|a[nñ]o) pasado|de (?:ni[nñ][oa]|chic[oa]|joven|peque[nñ][oa])|cuando era (?:ni[nñ][oa]|chic[oa]|joven)|si (?:alguien|alguno|alguna|una persona|un ni[nñ]o)|qu[eé] pasa si|en caso de)(?![\p{L}\p{N}])/iu;
/** A recent past (ayer, anoche, hace N ≤ 7 días): the only window for the E2 residual-hazard fallback. */
const ES_RECENT_PAST_RE =
  /(?<![\p{L}\p{N}])(?<!desde )(?:ayer|anoche|antier|anteayer|hace (?:un|una|dos|tres|cuatro|cinco|seis|siete|[1-7]) d[ií]as?)(?![\p{L}\p{N}])/iu;
/** Present urgency or recurrence: no downgrade anywhere in the utterance. */
const ES_PRESENT_URGENCY_RE =
  /(?<![\p{L}\p{N}])(?:ahora|ahorita|todav[ií]a|sigue|siguen|hoy|ayuda|auxilio|r[aá]pido|urgente|911|ambulancia|emergencia|otra vez|de nuevo|nuevamente)(?![\p{L}\p{N}])/iu;
/**
 * #1245 round 2 — a present symptom after a past event ("se electrocutó ayer y
 * está temblando"): no downgrade anywhere in the utterance. Not E1 on its own
 * ("el agua está fría", "el bebé está dormido").
 */
const ES_PRESENT_SYMPTOM_RE =
  /(?<![\p{L}\p{N}])(?:temblando|tiembla|dormid[oa]s?|somnolient[oa]s?|adormilad[oa]s?|d[eé]bil(?:es)?|confundid[oa]s?|desorientad[oa]s?|morad[oa]s?|p[aá]lid[oa]s?|fr[ií][oa]s?|helad[oa]s?|no despierta|no reacciona|mare[aoó]\p{L}*|mareos?|v[oó]mit\p{L}*|sudando fr[ií]o)(?![\p{L}\p{N}])/iu;

type InjuryIdiom = NonNullable<SpanishInjuryPattern['idiomWhen']>[number];
/** Idiom contexts for {@link SpanishInjuryPattern.idiomWhen}. */
const ES_INJURY_IDIOM_RE: Record<Exclude<InjuryIdiom, 'device_subject' | 'pet' | 'stuck'>, RegExp> = {
  // "no responde / no contesta" about a business, not a person (#1253 round 3).
  unanswered:
    /(?<![\p{L}\p{N}])(?:t[eé]cnicos?|tel[eé]fono|celular|oficina|empresa|compa[nñ][ií]a|mensajes?|llamadas?|correos?|whatsapp|plomero|electricista|contratista|n[uú]mero|recepci[oó]n)(?![\p{L}\p{N}])/giu,
  price:
    /(?<![\p{L}\p{N}])(?:precios?|costos?|caro|car[ií]simo|cuenta|factura|recibo|cobran|cobrar|cobro|de infarto|impuestos?|renta|tarifas?|cotizaci[oó]n(?:es)?|presupuestos?)(?![\p{L}\p{N}])/giu,
  laugh: /(?<![\p{L}\p{N}])(?:de (?:la )?risa|de tanto re[ií]r|re[ií]r|riendo)(?![\p{L}\p{N}])/giu,
  excess:
    /(?<![\p{L}\p{N}])de (?:caf[eé]|az[uú]car|chocolate|trabajo|informaci[oó]n|amor|televisi[oó]n|tele|redes|series|f[uú]tbol|estr[eé]s|realidad)(?![\p{L}\p{N}])/giu,
  device:
    /(?<![\p{L}\p{N}])(?:bomba|motor|calentador|boiler|caldera|planta|generador|carro|coche|m[aá]quina|compresor|carburador|equipo|termostato|control|pantalla|celular|app|aplicaci[oó]n|sistema|aparato|aire|minisplit|estufa|horno|lavadora|secadora|refrigerador|breaker|interruptor|panel|sensor|detector|alarma|puerta|port[oó]n|timbre|focos?|l[aá]mparas?|bombillas?|computadora|laptop|tablet|televisi[oó]n|tele|router|m[oó]dem|internet|wifi|se[nñ]al|plomero|electricista|empresa|compa[nñ][ií]a|mensajes?|llamadas?|correos?|whatsapp)(?![\p{L}\p{N}])/giu,
  figurative:
    /(?<![\p{L}\p{N}])(?:de amor|del coraz[oó]n|en su orgullo|en el orgullo|emocionalmente|sentimentalmente)(?![\p{L}\p{N}])/giu,
  fiction:
    /(?<![\p{L}\p{N}])(?:pel[ií]cula|serie|novela|libro|historia|cuento|programa|video|sue[nñ]o|so[nñ][eé])(?: [\p{L}]+){0,3} (?:sobre|acerca de)(?![\p{L}\p{N}])/giu,
};
const ES_PET_NOUN = 'perr[oa]s?|perrit[oa]s?|gat[oa]s?|gatit[oa]s?|mascotas?|cachorr[oa]s?';
/** The pet is the subject right before the match: "mi perro (ya) se tragó…". */
const ES_PET_SUBJECT_BEFORE_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:mi|mis|el|la|los|las|nuestr[oa]s?|su|sus|tu|tus) (?:${ES_PET_NOUN})(?: (?:ya|tambi[eé]n))?\\s*$`,
  'iu',
);
/** The pet is the subject right after the match: "se tragó una pila el perro". */
const ES_PET_SUBJECT_AFTER_RE = new RegExp(`^\\s*(?:el|la|mi|su|nuestr[oa]) (?:${ES_PET_NOUN})(?![\\p{L}\\p{N}])`, 'iu');
/** Idioms that always name a person: gated on harm only. */
const ES_HARM_GATED_IDIOMS: ReadonlySet<InjuryIdiom> = new Set(['figurative', 'fiction', 'stuck']);
/** Stuck somewhere unpleasant but not dangerous: "atrapado en el elevador / el tráfico" (E2, #1253 round 3). */
const ES_STUCK_BENIGN_AFTER_RE =
  /^ ?(?:el|la|un|una|los|las) (?:elevador|ascensor|tr[aá]fico|tr[aá]nsito|fila|cola|junta|reuni[oó]n|trabajo|embotellamiento)(?![\p{L}\p{N}])/iu;
/**
 * Readings that apply only when no person is referenced ANYWHERE, inside the
 * match included (#1253 review): a pet emergency, and a device as the subject
 * of "se desmayó/desvaneció".
 */
const ES_PERSON_ANYWHERE_IDIOMS: ReadonlySet<InjuryIdiom> = new Set(['pet', 'device_subject']);

/** "se desmayó/desvaneció <device>": the device is the grammatical subject right after the verb. */
const ES_DEVICE_SUBJECT_AFTER_RE =
  /^ (?:la|el|los|las|mi|su|tu) (?:se[nñ]al|wifi|internet|imagen|pantalla|conexi[oó]n|red|bater[ií]a|computadora|compu|laptop|tablet|tele|televisi[oó]n|video|app|aplicaci[oó]n|sistema|p[aá]gina|radio)(?![\p{L}\p{N}])/iu;

/**
 * #1253 round 2, rule 2 — the object-fall E2 reading is an EXACT utterance
 * shape: "se cayó <article> <household object> (y|,) no se puede mover / no se
 * mueve", nothing else. Any extra clause, name, symptom or plea, a plural or
 * "levantar" (a person gets up, an object does not) stays E1.
 */
const ES_EXACT_OBJECT_FALL_RE =
  /^se cay[oó] (?:el|la|los|las|un|una) (?:tele|televisi[oó]n|televisor|pantalla|mueble|cuadro|l[aá]mpara|repisa|estante|librero|tel[eé]fono|celular|plato|vaso|foco|antena|espejo|ropero|cl[oó]set|refri|refrigerador|lavadora|secadora|estufa|horno|microondas|computadora|puerta|cortina|maceta|ventilador|calentador|boiler|minisplit|caja|bote|cubeta)(?:,| y) no se (?:puede mover|mueve)$/iu;

/** The whole utterance, normalised for an exact-shape comparison. */
function normalisedUtterance(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/^[\s¿¡"'.,;:!?]+|[\s"'.,;:!?]+$/gu, '')
    .replace(/\s+/gu, ' ');
}

const ES_HARM_WORDS = `${SIGNAL_HARM}|inconscien\\p{L}*|desmay\\p{L}*|pecho|sangr\\p{L}*|desangr\\p{L}*|convuls\\p{L}*|pulso|herid[oa]s?|lastimad[oa]s?|golpe\\p{L}*|duele|dolor|paraliz\\p{L}*|pastillas|ambulancia|911|toc[oó]|tocar|toque|corriente|descarga|electrocut\\p{L}*|chispa\\p{L}*|cay[oó]|ca[ií]do|ca[ií]da|hospital|cl[ií]nica|m[eé]dicos?|doctor(?:a|es)?|param[eé]dicos?|urgencias`;
/**
 * A person, a harm, or how someone got hurt (touched a live wire, fell): an
 * idiom reading never applies with one. "tocó el foco y no responde" is E1.
 */
const ES_PERSON_OR_HARM_RE = new RegExp(
  // "él" only with its accent: unaccented "el" is the article in every sentence.
  `(?<![\\p{L}\\p{N}])(?:${ES_PERSON_NOUN}|él|ella|alguien|${ES_HARM_WORDS})(?![\\p{L}\\p{N}])`,
  'giu',
);
/** A harm or how someone got hurt, persons aside (for the figurative and fiction idioms). */
const ES_HARM_ONLY_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${ES_HARM_WORDS})(?![\\p{L}\\p{N}])`, 'giu');
/**
 * #1253 review — ANY reference to a person: a person noun, a pronoun (él/ella,
 * or le/lo/la + a verb: "le daba de comer", "lo encontré"), a kinship term.
 * Used anywhere in the utterance, inside the match included, by the E2
 * object-fall and pet readings.
 */
const ES_PERSON_REFERENCE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${ES_PERSON_NOUN}|hombres?|mujer(?:es)?|muchach[oa]s?|chamac[oa]s?|chav[oa]s?|chavit[oa]s?|viejit[oa]s?|ancian[oa]s?|nietos?|nietas?|chic[oa]s?|j[oó]ven(?:es)?|gente|personas|t[eé]cnicos?|plomeros?|electricistas?|pintor(?:es)?|obreros?|él|ella|ellos|ellas|alguien|nadie|(?:le|lo|la|les|los|las) (?:[\\p{L}]+(?:aba|aban|[ií]a|[ií]an|ó|é|í)|di|dio|dije|dijo|vi|vio|puse|puso|tengo|tiene))(?![\\p{L}\\p{N}])`,
  'giu',
);

/** A danger signal (leak, harm, fire/smoke/CO/alarm): the device scope of {@link hasLeakOrDangerSignal}. */
const DANGER_SIGNAL_RE_G = new RegExp(DANGER_SIGNAL_RE.source, 'giu');
/**
 * #1253 review — the ONE leak/danger lexicon of the gas price-question guard:
 * danger plus the words the #1241 leak patterns are built from (hissing,
 * broken). A named source or place is not a signal here (Josh, #1241).
 */
const GAS_QUESTION_SIGNAL_RE = signalRe(SIGNAL_LEAK, SIGNAL_HARM, SIGNAL_SPREAD, SIGNAL_GAS_TROUBLE);
const GAS_QUESTION_SIGNAL_RE_G = new RegExp(GAS_QUESTION_SIGNAL_RE.source, 'giu');

/** Another finite verb or a relative/subordinating word: a past marker next to it belongs to that verb. */
const ES_OTHER_VERB_TOKEN_RE =
  /^(?:que|cuando|donde|mientras|es|son|era|eran|fue|fueron|est[aá]|est[aá]n|estaba|estaban|estuvo|hay|hab[ií]a|hubo|tiene|tienen|ten[ií]a|tuvo|dijo|dijeron|hizo|hicieron|puso|pusieron|vino|vinieron|dej[oó]|dejaron|necesito|necesita|quiero|quiere|puede|pueden|vive|viven)$|^\p{L}{3,}(?:aron|ieron|aban|[ií]an)$|^\p{L}{2,}(?:ó|aba)$/iu;
/** A past verb that can govern a condition noun ("tuvo un infarto", "le dio una convulsión"). */
const ES_PAST_VERB_TOKEN_RE =
  /^(?:tuvo|tuve|tuvimos|tuvieron|tuviste|dio|dieron|fue|fueron|hubo|sufri[oó]|sufrieron|estuvo|estaba|ten[ií]a|hab[ií]a|pas[oó]|daba)$|^\p{L}{2,}ó$/iu;
const ES_PAST_MARKER_RE_G = new RegExp(ES_PAST_MARKER_RE.source, 'giu');

/**
 * #1245 round 2 / #1253 review — gas price question: "a cómo / cuánto (me/le)
 * sale el gas …". "a cómo" is only ever a price idiom; "cuánto" needs the
 * article ("cuánto sale gas del medidor" is leak grammar).
 */
const ES_GAS_PRICE_QUESTION_RE =
  /(?<![\p{L}\p{N}])(?<!(?:mira|miren|mire|ve|vea|ven|oye|oiga|ay|uy) )(?:a c[oó]mo|cu[aá]nto) (?:(?:me|le|les|nos|te) )?sal(?:e|en|dr[aá]) el (?:gas|propano)(?![\p{L}\p{N}])/giu;
/**
 * #1253 round 3 — a leak path right after the question ("a cómo sale el gas de
 * la estufa", "… por la llave") is where the gas is escaping, not a price. A
 * new install ("por la tubería nueva", "del calentador nuevo") and the tank
 * itself stay price questions.
 */
const ES_GAS_LEAK_PATH_AFTER_RE =
  /^ (?:de|del|por) (?:(?:la|el|las|los) )?(?:llaves?|estufas?|conexi[oó]n|conexiones|tuber[ií]as?|mangueras?|v[aá]lvulas?|regulador|hornillas?|quemador(?:es)?)(?![\p{L}\p{N}])(?! nuev[oa]s?)/iu;

// ─── Linear scan context (#1253 review) ─────────────────────────────────────
//
// The injury scan runs synchronously in the Twilio and media-stream handlers.
// Every per-match question (which clause, is there a signal outside this span,
// which past marker and verb are nearest) is answered from arrays built ONCE
// per transcript with single passes, so an 8k-character transcript is linear,
// not a rescan per match.

/** Sorted, non-overlapping regex matches with O(log n) "any match outside / inside a span" queries. */
class SpanIndex {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  constructor(text: string, globalRe: RegExp) {
    for (const m of text.matchAll(globalRe)) {
      this.starts.push(m.index ?? 0);
      this.ends.push((m.index ?? 0) + m[0].length);
    }
  }
  get size(): number {
    return this.starts.length;
  }
  /** Matches overlapping [s, e). */
  private overlapping(s: number, e: number): number {
    return lowerBound(this.starts, e) - upperBound(this.ends, s);
  }
  /** Any match that does not overlap [s, e) (the "rest of the utterance"). */
  anyOutside(s: number, e: number): boolean {
    return this.size - Math.max(0, this.overlapping(s, e)) > 0;
  }
  /**
   * Any match inside [from, to) that does not overlap [s, e). O(log n): matches
   * are sorted and non-overlapping, so the only candidates are the first match
   * at or after `from` and the first match at or after `e`.
   */
  anyWithinExcept(from: number, to: number, s: number, e: number): boolean {
    const i0 = lowerBound(this.starts, from);
    if (i0 < this.size && this.ends[i0]! <= to && (this.ends[i0]! <= s || this.starts[i0]! >= e)) return true;
    const i1 = lowerBound(this.starts, Math.max(from, e));
    return i1 < this.size && this.ends[i1]! <= to;
  }
  /** Any match inside [from, to). O(log n). */
  anyWithin(from: number, to: number): boolean {
    const i0 = lowerBound(this.starts, from);
    return i0 < this.size && this.ends[i0]! <= to;
  }
  /** Number of matches inside [from, to). O(log n). */
  countWithin(from: number, to: number): number {
    return Math.max(0, upperBound(this.ends, to) - lowerBound(this.starts, from));
  }
  /** The first match overlapping [s, e), or null. O(log n). */
  overlap(s: number, e: number): { start: number; end: number } | null {
    const i = upperBound(this.ends, s);
    return i < this.size && this.starts[i]! < e ? { start: this.starts[i]!, end: this.ends[i]! } : null;
  }
}

/** First index whose value is >= target. */
function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** First index whose value is > target. */
function upperBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface ScanContext {
  readonly text: string;
  readonly breakStarts: number[];
  readonly breakEnds: number[];
  readonly tokenStarts: number[];
  readonly tokenEnds: number[];
  /** Per token: the marker id it belongs to, or -1. */
  readonly markerOf: Int32Array;
  readonly markers: ReadonlyArray<{ first: number; last: number; text: string }>;
  /** Per token: nearest other-verb token index at or before / after it (-1 / tokens.length when none). */
  readonly prevVerb: Int32Array;
  readonly nextVerb: Int32Array;
  /** Prefix count of other-verb tokens: verbPrefix[i] = verbs in tokens [0, i). */
  readonly verbPrefix: Int32Array;
  /** Per token: nearest any-verb (other or past) before it, or -1, for a noun's governing verb. */
  readonly prevAnyVerb: Int32Array;
  readonly isPastVerb: Uint8Array;
  /** Per token: id of the nearest marker ending before / starting after it (-1 when none). */
  readonly markerBefore: Int32Array;
  readonly markerAfter: Int32Array;
  readonly presentBlock: boolean;
  /** The whole utterance is the exact object-fall shape (rule 2). */
  readonly exactObjectFall: boolean;
  readonly danger: SpanIndex;
  readonly personOrHarm: SpanIndex;
  readonly harmOnly: SpanIndex;
  readonly personReference: SpanIndex;
  readonly gasQuestionSignal: SpanIndex;
  /** Hazard-suppressor indexes (#1253 round 3: every routine reading answered in O(log n)). */
  readonly gasSignal: SpanIndex;
  readonly combustionSignal: SpanIndex;
  readonly priceWords: SpanIndex;
  readonly englishWords: SpanIndex;
  readonly flameColour: SpanIndex;
  readonly heating: SpanIndex;
  readonly firstTime: SpanIndex;
  readonly cooking: SpanIndex;
  readonly outdoors: SpanIndex;
  readonly otherSmokeCause: SpanIndex;
  readonly igniterOnly: boolean;
  readonly coDeviceWork: boolean;
  readonly idioms: Record<Exclude<InjuryIdiom, 'device_subject' | 'pet' | 'stuck'>, SpanIndex>;
  readonly priceQuestions: ReadonlyArray<{ start: number; end: number }>;
}

let lastScanContext: ScanContext | null = null;

function scanContext(text: string): ScanContext {
  if (lastScanContext?.text === text) return lastScanContext;
  const breakStarts: number[] = [];
  const breakEnds: number[] = [];
  for (const b of text.matchAll(CLAUSE_BREAK_RE)) {
    breakStarts.push(b.index ?? 0);
    breakEnds.push((b.index ?? 0) + b[0].length);
  }
  const tokenStarts: number[] = [];
  const tokenEnds: number[] = [];
  const words: string[] = [];
  for (const t of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    tokenStarts.push(t.index ?? 0);
    tokenEnds.push((t.index ?? 0) + t[0].length);
    words.push(t[0]);
  }
  const n = words.length;
  const markerOf = new Int32Array(n).fill(-1);
  const markers: Array<{ first: number; last: number; text: string }> = [];
  for (const m of text.matchAll(ES_PAST_MARKER_RE_G)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    const first = lowerBound(tokenEnds, s + 1);
    const last = lowerBound(tokenStarts, e) - 1;
    if (first > last) continue;
    const id = markers.length;
    markers.push({ first, last, text: m[0] });
    for (let i = first; i <= last; i += 1) markerOf[i] = id;
  }
  const isOtherVerb = new Uint8Array(n);
  const isPastVerb = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (markerOf[i] !== -1) continue;
    if (ES_OTHER_VERB_TOKEN_RE.test(words[i]!)) isOtherVerb[i] = 1;
    if (ES_PAST_VERB_TOKEN_RE.test(words[i]!)) isPastVerb[i] = 1;
  }
  const prevVerb = new Int32Array(n);
  const prevAnyVerb = new Int32Array(n);
  const verbPrefix = new Int32Array(n + 1);
  const markerBefore = new Int32Array(n);
  let lastVerb = -1;
  let lastAny = -1;
  let lastMarker = -1;
  for (let i = 0; i < n; i += 1) {
    prevAnyVerb[i] = lastAny;
    markerBefore[i] = lastMarker;
    if (isOtherVerb[i]) lastVerb = i;
    if (isOtherVerb[i] || isPastVerb[i]) lastAny = i;
    prevVerb[i] = lastVerb;
    verbPrefix[i + 1] = verbPrefix[i]! + isOtherVerb[i]!;
    if (markerOf[i] !== -1 && (i === n - 1 || markerOf[i + 1] !== markerOf[i])) lastMarker = markerOf[i]!;
  }
  const nextVerb = new Int32Array(n);
  const markerAfter = new Int32Array(n);
  let nextV = n;
  let nextM = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    markerAfter[i] = nextM;
    if (isOtherVerb[i]) nextV = i;
    nextVerb[i] = nextV;
    if (markerOf[i] !== -1 && (i === 0 || markerOf[i - 1] !== markerOf[i])) nextM = markerOf[i]!;
  }
  const priceQuestions = [...text.matchAll(ES_GAS_PRICE_QUESTION_RE)].map((q) => ({
    start: q.index ?? 0,
    end: (q.index ?? 0) + q[0].length,
  }));
  lastScanContext = {
    text,
    breakStarts,
    breakEnds,
    tokenStarts,
    tokenEnds,
    markerOf,
    markers,
    prevVerb,
    nextVerb,
    verbPrefix,
    prevAnyVerb,
    isPastVerb,
    markerBefore,
    markerAfter,
    presentBlock: ES_PRESENT_URGENCY_RE.test(text) || ES_PRESENT_SYMPTOM_RE.test(text),
    exactObjectFall: ES_EXACT_OBJECT_FALL_RE.test(normalisedUtterance(text)),
    danger: new SpanIndex(text, DANGER_SIGNAL_RE_G),
    personOrHarm: new SpanIndex(text, ES_PERSON_OR_HARM_RE),
    harmOnly: new SpanIndex(text, ES_HARM_ONLY_RE),
    personReference: new SpanIndex(text, ES_PERSON_REFERENCE_RE),
    gasQuestionSignal: new SpanIndex(text, GAS_QUESTION_SIGNAL_RE_G),
    gasSignal: new SpanIndex(text, new RegExp(LEAK_OR_DANGER_SIGNAL_RE.source, 'giu')),
    combustionSignal: new SpanIndex(text, new RegExp(DANGER_OR_ENCLOSED_SIGNAL_RE.source, 'giu')),
    priceWords: new SpanIndex(text, new RegExp(ES_PRICE_RE.source, 'giu')),
    englishWords: new SpanIndex(text, EN_ONLY_WORD_RE),
    flameColour: new SpanIndex(text, new RegExp(ES_FLAME_COLOUR_RE.source, 'giu')),
    heating: new SpanIndex(text, /(?<![\p{L}\p{N}])calefacci[oó]n(?![\p{L}\p{N}])/giu),
    firstTime: new SpanIndex(text, /(?<![\p{L}\p{N}])por primera vez(?![\p{L}\p{N}])/giu),
    cooking: new SpanIndex(text, /(?<![\p{L}\p{N}])(?:carne asada|asados?|parrillas?|asador|barbacoa)(?![\p{L}\p{N}])/giu),
    outdoors: new SpanIndex(text, /(?<![\p{L}\p{N}])(?:patio|afuera|jard[ií]n|terraza|yarda)(?![\p{L}\p{N}])/giu),
    otherSmokeCause: new SpanIndex(text, /(?<![\p{L}\p{N}])(?:fogata|cigarros?|cigarrillos?|incienso)(?![\p{L}\p{N}])/giu),
    igniterOnly: ES_IGNITER_RE.test(text) && !ES_ELECTRICAL_LOCATION_RE.test(text),
    coDeviceWork: ES_CO_DEVICE_RE.test(text) && ES_DEVICE_WORK_RE.test(text) && !ES_ALARM_SOUNDING_RE.test(text),
    idioms: {
      price: new SpanIndex(text, ES_INJURY_IDIOM_RE.price),
      laugh: new SpanIndex(text, ES_INJURY_IDIOM_RE.laugh),
      excess: new SpanIndex(text, ES_INJURY_IDIOM_RE.excess),
      device: new SpanIndex(text, ES_INJURY_IDIOM_RE.device),
      unanswered: new SpanIndex(text, ES_INJURY_IDIOM_RE.unanswered),
      figurative: new SpanIndex(text, ES_INJURY_IDIOM_RE.figurative),
      fiction: new SpanIndex(text, ES_INJURY_IDIOM_RE.fiction),
    },
    priceQuestions,
  };
  return lastScanContext;
}

/** {@link clauseBounds} in O(log n) from the precomputed breaks. */
function clauseOf(ctx: ScanContext, s: number, e: number): { start: number; end: number } {
  const lastBefore = upperBound(ctx.breakEnds, s) - 1;
  const start = lastBefore >= 0 ? ctx.breakEnds[lastBefore]! : 0;
  const firstAfter = lowerBound(ctx.breakStarts, e);
  const end = firstAfter < ctx.breakStarts.length ? ctx.breakStarts[firstAfter]! : ctx.text.length;
  return { start, end };
}

type InjuryHit = (typeof INJURY_REGEXES_ES)[number] & { index: number; text: string };

/**
 * Every Spanish injury match that is not an idiom reading, plus the keywords
 * of matches demoted to an E2 reading (ambiguous object fall, pet). ALL
 * matches of each entry count (#1245 round 2).
 */
function spanishInjuryHits(ctx: ScanContext): { hits: InjuryHit[]; demotedE2: string[] } {
  const hits: InjuryHit[] = [];
  const demotedE2: string[] = [];
  for (const entry of INJURY_REGEXES_ES) {
    for (const match of ctx.text.matchAll(entry.regexAll)) {
      const index = match.index ?? 0;
      const text = match[0];
      // #1253 round 2, rule 1: a heuristic reading lowers E1 to E2 at most.
      const idiom = entry.idiomWhen ? injuryIdiom(ctx, entry.idiomWhen, index, text) : null;
      if (idiom || (entry.keyword === 'se cayó y no se puede mover' && ctx.exactObjectFall)) {
        demotedE2.push(entry.keyword);
        continue;
      }
      hits.push({ ...entry, index, text });
    }
  }
  return { hits, demotedE2 };
}

/**
 * The idiom reading that applies to this match, or null.
 * - price / laugh / excess / device / figurative / fiction / pet: the idiom
 *   context shares the clause with the match (outside the match), and the rest
 *   of the utterance has no person-or-harm signal (harm only, for figurative
 *   and fiction).
 * - object_fall and pet (E2 readings): additionally, no person reference
 *   ANYWHERE, inside the match included (#1253 review). object_fall only
 *   recognises a listed household object as what fell.
 */
function injuryIdiom(
  ctx: ScanContext,
  kinds: ReadonlyArray<InjuryIdiom>,
  index: number,
  text: string,
): InjuryIdiom | null {
  const end = index + text.length;
  const clause = clauseOf(ctx, index, end);
  for (const kind of kinds) {
    if (kind === 'device_subject') {
      if (!ES_DEVICE_SUBJECT_AFTER_RE.test(ctx.text.slice(end, end + 40))) continue;
    } else if (kind === 'stuck') {
      if (!ES_STUCK_BENIGN_AFTER_RE.test(ctx.text.slice(end, end + 40))) continue;
    } else if (kind === 'pet') {
      // The pet must be what swallowed or took it, not a bystander ("mientras
      // jugaba con el perro"). Bounded look-around, O(1) per match.
      const before = ctx.text.slice(Math.max(0, index - 40), index);
      const after = ctx.text.slice(end, end + 40);
      if (!ES_PET_SUBJECT_BEFORE_RE.test(before) && !ES_PET_SUBJECT_AFTER_RE.test(after)) continue;
    } else if (!ctx.idioms[kind].anyWithinExcept(clause.start, clause.end, index, end)) {
      continue;
    }
    if (ES_PERSON_ANYWHERE_IDIOMS.has(kind)) {
      if (ctx.personReference.size > 0 || ctx.harmOnly.anyOutside(index, end)) continue;
      return kind;
    }
    const gate = ES_HARM_GATED_IDIOMS.has(kind) ? ctx.harmOnly : ctx.personOrHarm;
    if (gate.anyOutside(index, end)) continue;
    return kind;
  }
  return null;
}

/**
 * #1245 round 2 — the past marker that modifies THIS event, if any. Scoped to
 * the event's clause and to the verb nearest the marker: a marker closer to (or
 * tied with) another verb or a "que" clause belongs to that verb. A noun's span
 * starts at its governing past verb; without one the noun is not past. Only the
 * nearest marker on each side can attach (a farther one has that marker or a
 * verb in between), so each query is O(log n) over the precomputed arrays.
 */
function attachedPastMarker(ctx: ScanContext, hit: InjuryHit): string | null {
  const end = hit.index + hit.text.length;
  const clause = clauseOf(ctx, hit.index, end);
  const clauseFirst = lowerBound(ctx.tokenEnds, clause.start + 1);
  const clauseLast = lowerBound(ctx.tokenStarts, clause.end) - 1;
  let spanFirst = lowerBound(ctx.tokenEnds, hit.index + 1);
  const spanLast = lowerBound(ctx.tokenStarts, end) - 1;
  if (spanFirst > spanLast) return null;

  if (hit.aspect === 'noun') {
    const governing = spanFirst > 0 ? ctx.prevAnyVerb[spanFirst]! : -1;
    if (governing < clauseFirst || !ctx.isPastVerb[governing]) return null;
    spanFirst = governing;
  }
  const verbsBetween = (a: number, b: number) => (b < a ? 0 : ctx.verbPrefix[b + 1]! - ctx.verbPrefix[a]!);
  const leftVerbGap = (from: number, markerFirst: number) => {
    const v = from > 0 ? ctx.prevVerb[from - 1]! : -1;
    return v >= clauseFirst ? markerFirst - v - 1 : Infinity;
  };
  const rightVerbGap = (from: number, markerLast: number) => {
    const v = from < ctx.nextVerb.length ? ctx.nextVerb[from]! : ctx.nextVerb.length;
    return v <= clauseLast ? v - markerLast - 1 : Infinity;
  };

  // Marker after the event: competing verbs are the nearest one before the
  // event and the nearest one after the marker (none may sit in between).
  const after = ctx.markerAfter[spanLast]!;
  if (after >= 0) {
    const m = ctx.markers[after]!;
    if (m.last <= clauseLast && verbsBetween(spanLast + 1, m.first - 1) === 0) {
      const toEvent = m.first - spanLast - 1;
      const toOther = Math.min(leftVerbGap(spanFirst, m.first), rightVerbGap(m.last + 1, m.last));
      if (toEvent < toOther) return m.text;
    }
  }
  // Marker before the event: competing verbs are the nearest one before the
  // marker and the nearest one after the event.
  const before = ctx.markerBefore[spanFirst]!;
  if (before >= 0) {
    const m = ctx.markers[before]!;
    if (m.first >= clauseFirst && verbsBetween(m.last + 1, spanFirst - 1) === 0) {
      const toEvent = spanFirst - m.last - 1;
      const toOther = Math.min(leftVerbGap(m.first, m.first), rightVerbGap(spanLast + 1, m.last));
      if (toEvent < toOther) return m.text;
    }
  }
  return null;
}

/**
 * True only for an event or noun match with a past or hypothetical marker
 * attached to its own verb, and no present urgency, present symptom or danger
 * signal anywhere in the utterance. A state is never past.
 */
function isSpanishClearlyPastEvent(ctx: ScanContext, hit: InjuryHit): boolean {
  if (hit.aspect === 'state') return false;
  if (!attachedPastMarker(ctx, hit)) return false;
  if (ctx.presentBlock) return false;
  return !ctx.danger.anyOutside(hit.index, hit.index + hit.text.length);
}

let lastInjuryText: string | null = null;
let lastInjuryVerdict: { e1?: string; residualE2?: string } = {};

/** #1221/#1245 — the Spanish injury verdict: an E1 keyword, an E2 keyword, or neither. Memoised per transcript. */
function classifySpanishInjury(transcript: string): { e1?: string; residualE2?: string } {
  if (lastInjuryText === transcript) return lastInjuryVerdict;
  const ctx = scanContext(transcript);
  const { hits, demotedE2 } = spanishInjuryHits(ctx);
  let verdict: { e1?: string; residualE2?: string } = {};
  const state = hits.find((h) => h.aspect === 'state');
  const live = state ?? hits.find((h) => !isSpanishClearlyPastEvent(ctx, h));
  if (live) {
    verdict = { e1: live.keyword };
  } else {
    const recent = hits.find((h) => {
      if (h.pastReportTier !== 'E2') return false;
      const marker = attachedPastMarker(ctx, h);
      return marker !== null && ES_RECENT_PAST_RE.test(marker);
    });
    const e2 = recent?.keyword ?? demotedE2[0];
    if (e2) verdict = { residualE2: e2 };
  }
  lastInjuryText = transcript;
  lastInjuryVerdict = verdict;
  return verdict;
}

/**
 * The gas price question overlapping a "sale gas" match, when nothing outside
 * the question signals a leak or harm in the shared gas lexicon (#1253 review).
 * A named source or place is not a signal here. Returns true when the match is
 * a plain price question.
 */
function gasPriceQuestionAt(transcript: string, index: number, length: number): boolean {
  const ctx = scanContext(transcript);
  const qs = ctx.priceQuestions;
  let lo = 0;
  let hi = qs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (qs[mid]!.end <= index) lo = mid + 1;
    else hi = mid;
  }
  const q = qs[lo];
  if (!q || q.start >= index + length) return false;
  return isPlainGasPriceQuestion(ctx, q);
}

/** A price question with no leak/harm signal outside it and no leak path right after it. */
function isPlainGasPriceQuestion(ctx: ScanContext, q: { start: number; end: number }): boolean {
  if (ctx.gasQuestionSignal.anyOutside(q.start, q.end)) return false;
  return !ES_GAS_LEAK_PATH_AFTER_RE.test(ctx.text.slice(q.end, q.end + 40));
}

interface LifeSafetyScan {
  readonly e1?: { keyword: string; language: EmergencyLanguage };
  /** #1253 round 2, rule 1: an E1 phrase lowered by a heuristic reading lands here (E2). */
  readonly floorE2?: string;
}

/**
 * Which routine readings may take a hazard to E3. Igniter sparks and CO-device
 * work are reviewed routine calls (#1234). Price/English, flame colour and
 * benign smoke outside the two approved shapes stop at E2 (#1253 round 2, rule 1).
 */
function routineReadingReachesE3(
  kind: NonNullable<SpanishHazardPattern['routineWhen']>,
  transcript: string,
  match: RegExpMatchArray,
): boolean {
  if (kind === 'igniter_sparks' || kind === 'co_device_request') return true;
  if (kind !== 'benign_smoke') return false;
  const ctx = scanContext(transcript);
  const index = match.index ?? 0;
  const shape = benignSmokeShape(ctx, clauseOf(ctx, index, index + match[0].length));
  return shape === 'first_heat' || shape === 'outdoor_cooking';
}

let lastLifeSafetyText: string | null = null;
let lastLifeSafetyScan: LifeSafetyScan = {};

/** The embedded life-safety scan: an E1 verdict, or the E2 floor of a lowered E1 phrase. Memoised per transcript. */
function scanLifeSafety(transcript: string): LifeSafetyScan {
  if (lastLifeSafetyText === transcript) return lastLifeSafetyScan;
  const scan = scanLifeSafetyUncached(transcript);
  lastLifeSafetyText = transcript;
  lastLifeSafetyScan = scan;
  return scan;
}

/**
 * #1253 round 3 — the ONE enforcement point of the E2 floor. Every heuristic
 * reading that lowers an E1 phrase reports here: a gas price question, a routine
 * hazard reading (price/English, flame colour, benign smoke), an injury idiom
 * (price, laugh, excess, device, device subject, unanswered, figurative, fiction,
 * pet, stuck) and the exact object-fall shape. The only readings allowed to go
 * lower are the two approved benign-smoke shapes and the #1234 routine
 * igniter/CO-device readings, and they say so through `reachesE3`.
 */
class HeuristicFloor {
  private keyword: string | undefined;
  lower(keyword: string, reachesE3 = false): void {
    if (!reachesE3) this.keyword ??= keyword;
  }
  get floorE2(): string | undefined {
    return this.keyword;
  }
}

function scanLifeSafetyUncached(transcript: string): LifeSafetyScan {
  const floor = new HeuristicFloor();
  // Acute hazards: always E1.
  for (const { keyword, regex } of HAZARD_REGEXES) {
    if (regex.test(transcript)) return { e1: { keyword, language: 'en' } };
  }
  for (const { keyword, regex, regexAll, routineWhen, priceQuestion } of HAZARD_REGEXES_ES) {
    if (!routineWhen && !priceQuestion) {
      if (regex.test(transcript)) return { e1: { keyword, language: 'es' } };
      continue;
    }
    // A suppressible entry: EVERY match is judged (a lowered first match must
    // not hide a live second one).
    for (const match of transcript.matchAll(regexAll)) {
      const index = match.index ?? 0;
      if (priceQuestion && gasPriceQuestionAt(transcript, index, match[0].length)) {
        floor.lower(keyword);
        continue;
      }
      if (routineWhen && isSpanishRoutineContext(routineWhen, transcript, match)) {
        floor.lower(keyword, routineReadingReachesE3(routineWhen, transcript, match));
        continue;
      }
      return { e1: { keyword, language: 'es' } };
    }
  }
  // Injury: E1 unless clearly past/hypothetical AND no present-tense urgency.
  const clearlyNonAcute =
    PAST_OR_HYPOTHETICAL_RE.test(transcript) && !PRESENT_URGENCY_RE.test(transcript);
  if (!clearlyNonAcute) {
    for (const { keyword, regex } of INJURY_REGEXES) {
      if (regex.test(transcript)) return { e1: { keyword, language: 'en' } };
    }
    for (const { keyword, regex, carriesNegation } of INJURY_REGEXES_EN) {
      const match = regex.exec(transcript);
      if (!match) continue;
      const prefix = transcript.slice(Math.max(0, match.index - 32), match.index);
      if (
        !carriesNegation &&
        /\b(?:no|not|never|isn'?t|wasn'?t|no longer|no (?:one|body) is)\s*$/i.test(prefix)
      )
        continue;
      return { e1: { keyword, language: 'en' } };
    }
    if (COLLAPSED_PERSON_RE.test(transcript)) {
      return { e1: { keyword: 'collapsed', language: 'en' } };
    }
  }
  // #1221 — Spanish injury/medical: a present symptom is always E1; an event
  // is E1 unless its own clause is clearly past (#1245 review). Idiom readings,
  // the exact object-fall shape and a recent past shock report to the floor.
  const spanishInjury = classifySpanishInjury(transcript);
  if (spanishInjury.e1) return { e1: { keyword: spanishInjury.e1, language: 'es' } };
  if (spanishInjury.residualE2) floor.lower(spanishInjury.residualE2);
  // A price question no "sale gas" entry matched ("¿cuánto les saldrá el gas?").
  const ctx = scanContext(transcript);
  if (ctx.priceQuestions.some((q) => isPlainGasPriceQuestion(ctx, q))) floor.lower('pregunta de precio del gas');
  return floor.floorE2 ? { floorE2: floor.floorE2 } : {};
}

/** Pure, synchronous, free — the embedded E1 life-safety scan. */
export function detectLifeSafetyE1(
  transcript: string,
): { matched: boolean; keyword?: string; language?: EmergencyLanguage } {
  const scan = scanLifeSafety(transcript);
  return scan.e1 ? { matched: true, keyword: scan.e1.keyword, language: scan.e1.language } : { matched: false };
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
  // #1221/#1253 — a recent past shock, or an E1 phrase lowered by a heuristic
  // reading (price, figurative, device, object-fall shape, pet, flame colour,
  // smoke outside the approved shapes): E2 floor, a human redirects it.
  const floorE2 = e1.matched ? null : (scanLifeSafety(text).floorE2 ?? null);
  if (floorE2) candidates.push({ tier: 'E2', source: 'embedded', keyword: floorE2, language: 'es' });

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
