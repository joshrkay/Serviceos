/**
 * generate-utterances.ts — deterministic synthetic utterance generator.
 *
 * Expands hand-authored seed templates (data/corpus/seeds/) into the
 * Spanish inbound-call corpus by combining:
 *   templates x discourse-prefix variation x PRNG-sampled slot fillers
 * with exact-text dedup. Reproducible: same seeds => same output.
 *
 * Output:
 *   data/corpus/utterances_es.jsonl          (Spanish + code-switch)
 *
 * English production/operator examples are the reviewed 41-intent corpus in
 * utterances.jsonl. They deliberately use the production intent taxonomy and
 * are not mixed with this separate 35-behavior inbound-call dataset.
 *
 * Run: pnpm corpus:generate   (or  npx tsx scripts/data-pipeline/generate-utterances.ts)
 */
import { join } from 'node:path';
import {
  CORPUS_DIR,
  SEEDS_DIR,
  mulberry32,
  normalizeText,
  readJson,
  writeJsonl,
  pick,
  capFirst,
  lowerFirst,
} from './lib';

interface Fillers {
  [bank: string]: string[];
}
interface TemplateFile {
  templates: Record<string, string[]>;
}
export interface Utterance {
  id: string;
  text: string;
  intent: string;
  lang: 'en' | 'es';
  code_switch: boolean;
  source: 'synthetic_template';
  reviewed_by_human: boolean;
}

const PREFIXES_ES = ['', 'Hola, ', 'Sí, ', 'Este, ', 'Oiga, ', 'Mire, ', 'Bueno, ', 'Perdón, ', 'Disculpe, ', 'Eh, '];

// English loanwords whose presence in a Spanish template marks code-switching.
const CODE_SWITCH_MARKERS = [
  'plumber', 'appointment', 'estimate', 'invoice', 'callback', 'backorder',
  'tankless', 'link', 'feedback', 'lead', 'working', 'ok', 'okay',
];

const ES_TARGET_PER_INTENT = 40; // >= 30 required; 35 intents * 40 ~= 1,400 (>= 1,200)
const REVIEWED_TEMPLATE_CUTOFF = 2; // first N templates per intent are hand-reviewed canon

function fill(template: string, fillers: Fillers, rng: () => number): string {
  let out = template;
  const subs: Record<string, () => string> = {
    '{service}': () => pick(fillers.service_en, rng),
    '{symptom}': () => pick(fillers.symptom_en, rng),
    '{time}': () => pick(fillers.time_phrase_en, rng),
    '{service_es}': () => pick(fillers.service_es, rng),
    '{symptom_es}': () => pick(fillers.symptom_es, rng),
    '{time_es}': () => pick(fillers.time_phrase_es, rng),
    '{first}': () => pick(fillers.first_name, rng),
    '{last}': () => pick(fillers.last_name, rng),
    '{street}': () => pick(fillers.street_name, rng),
    '{suffix}': () => pick(fillers.street_suffix, rng),
    '{street_num}': () => String(100 + Math.floor(rng() * 900)),
    '{job_ref}': () => pick(fillers.job_ref_en, rng),
  };
  for (const [token, gen] of Object.entries(subs)) {
    while (out.includes(token)) out = out.replace(token, gen());
  }
  return out;
}

function applyPrefix(prefix: string, core: string): string {
  if (prefix === '') return capFirst(core);
  return prefix + lowerFirst(core);
}

function generate(
  lang: 'en' | 'es',
  templateFile: TemplateFile,
  fillers: Fillers,
  prefixes: string[],
  targetPerIntent: number,
  seed: number,
): Utterance[] {
  const rng = mulberry32(seed);
  const out: Utterance[] = [];
  let counter = 0;
  const intents = Object.keys(templateFile.templates).sort();
  for (const intent of intents) {
    const templates = templateFile.templates[intent];
    const seen = new Set<string>();
    let perIntent = 0;
    // Iterate (prefix, template) so canonical (no-prefix) variants come first.
    outer: for (let pi = 0; pi < prefixes.length; pi++) {
      for (let ti = 0; ti < templates.length; ti++) {
        if (perIntent >= targetPerIntent) break outer;
        const core = fill(templates[ti], fillers, rng);
        const text = applyPrefix(prefixes[pi], core);
        const norm = normalizeText(text);
        if (seen.has(norm)) continue;
        seen.add(norm);
        const codeSwitch =
          lang === 'es' && CODE_SWITCH_MARKERS.some((m) => new RegExp(`\\b${m}\\b`, 'i').test(templates[ti]));
        out.push({
          id: `utt_${lang}_${String(++counter).padStart(6, '0')}`,
          text,
          intent,
          lang,
          code_switch: codeSwitch,
          source: 'synthetic_template',
          reviewed_by_human: ti < REVIEWED_TEMPLATE_CUTOFF,
        });
        perIntent++;
      }
    }
  }
  return out;
}

function main(): void {
  const fillers = readJson<Fillers>(join(SEEDS_DIR, 'fillers.json'));
  const es = readJson<TemplateFile>(join(SEEDS_DIR, 'templates.es.json'));

  const esRows = generate('es', es, fillers, PREFIXES_ES, ES_TARGET_PER_INTENT, 0x5e_70_02);

  writeJsonl(join(CORPUS_DIR, 'utterances_es.jsonl'), esRows);

  const esReviewed = esRows.filter((r) => r.reviewed_by_human).length;
  const esCodeSwitch = esRows.filter((r) => r.code_switch).length;
  const esByIntent = new Map<string, number>();
  for (const r of esRows) esByIntent.set(r.intent, (esByIntent.get(r.intent) ?? 0) + 1);
  const minEsPerIntent = Math.min(...esByIntent.values());

  console.error(`[generate] ES utterances: ${esRows.length} (reviewed ${esReviewed}, ${pct(esReviewed, esRows.length)})`);
  console.error(`[generate] ES code-switch: ${esCodeSwitch}; min ES/intent: ${minEsPerIntent}`);
}

function pct(n: number, d: number): string {
  return d === 0 ? '0%' : `${((100 * n) / d).toFixed(1)}%`;
}

main();
