#!/usr/bin/env npx tsx
/**
 * generate-transcripts.ts — build data/fixtures/transcripts/*.json (target 300+).
 *
 *   - Copies the 3 REAL seed transcripts from fixtures/ai/transcripts/ verbatim
 *     (marked "source":"real_seed").
 *   - Deterministically composes synthetic inbound-call transcripts from call-
 *     flow templates × trade × equipment/symptom (drawn from data/vocab) ×
 *     name/address/time pools. Marked "source":"synthetic".
 *
 * Each transcript keeps the existing fixture schema (id, type, duration_seconds,
 * service_type, transcript, expected_entities) so the files double as gold data
 * for the slot-extraction eval.
 *
 * Run: npx tsx scripts/data-pipeline/generate-transcripts.ts
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const REAL_SEED_DIR = resolve(ROOT, 'fixtures/ai/transcripts');
const OUT_DIR = resolve(ROOT, 'data/fixtures/transcripts');

const TARGET = 305;

interface Transcript {
  id: string;
  type: string;
  duration_seconds: number;
  service_type: string;
  transcript: string;
  expected_entities: Record<string, string>;
  source?: string;
}

const NAMES = ['Sarah Johnson', 'James Miller', 'Maria Lopez', 'Robert Klein', 'Linda Park', 'David Carter', 'Angela Reed', 'Tom Bradley', 'Jennifer Wu', 'Gary Olsen', 'Patricia Hall', 'Carlos Mendez', 'Susan Diaz', 'Mark Henderson', 'Helen Park'];
const ADDRESSES = ['456 Oak Avenue', '88 Maple Ave', '1500 Sunset Blvd', '22 Oak Court', '9 Lakeview Drive', '5 River Road', '200 Market Street', '314 Birch Lane', '18 Cedar Court', '7 River Road', '101 Pine Street', '640 Willow Way'];
const WINDOWS = ['tomorrow between 8 and 10 AM', 'this afternoon between 2 and 4', 'Thursday morning', 'next Monday at 9', 'Saturday between 10 and 12', 'today if possible', 'Wednesday afternoon', 'first thing tomorrow'];
const AGES = ['about 5 years old', 'maybe 10 years old', 'pretty new, 2 years', 'an older one, 15 years', 'about 8 years old'];

interface TradeSpec {
  service_type: string;
  equipment: string[];
  brands: string[];
  symptoms: string[];
}
const TRADES: TradeSpec[] = [
  {
    service_type: 'hvac',
    equipment: ['AC unit', 'furnace', 'heat pump', 'air handler', 'condenser', 'mini split', 'package unit', 'thermostat'],
    brands: ['Carrier', 'Trane', 'Lennox', 'Goodman', 'Rheem', 'Bryant', 'York', 'Daikin'],
    symptoms: ['stopped cooling', 'is blowing warm air', 'is making a loud noise', 'is leaking water', 'keeps short cycling', 'froze up with ice on the lines', 'won\'t turn on', 'is blowing cold air instead of heat'],
  },
  {
    service_type: 'plumbing',
    equipment: ['water heater', 'toilet', 'garbage disposal', 'sump pump', 'faucet', 'shower valve', 'main sewer line', 'shutoff valve'],
    brands: ['Kohler', 'Moen', 'Delta', 'Rheem', 'Bradford White', 'AO Smith', 'Rinnai'],
    symptoms: ['is leaking', 'is clogged', 'has no hot water', 'keeps running', 'has low water pressure', 'is backing up', 'won\'t drain', 'is making a gurgling sound'],
  },
  {
    service_type: 'electrical',
    equipment: ['electrical panel', 'breaker', 'GFCI outlet', 'light fixture', 'outlet', 'ceiling fan', 'sub-panel'],
    brands: ['Square D', 'Eaton', 'Siemens', 'Leviton', 'Generac'],
    symptoms: ['keeps tripping the breaker', 'is sparking', 'is not working', 'is flickering', 'is buzzing', 'is hot to the touch', 'has no power'],
  },
];

function pick<T>(arr: T[], i: number): T { return arr[i % arr.length]; }
function firstName(full: string): string { return full.split(' ')[0]; }

function booking(t: TradeSpec, i: number): Transcript {
  const name = pick(NAMES, i);
  const addr = pick(ADDRESSES, i * 3 + 1);
  const equip = pick(t.equipment, i);
  const brand = pick(t.brands, i * 2);
  const sym = pick(t.symptoms, i * 5 + 2);
  const age = pick(AGES, i);
  const win = pick(WINDOWS, i * 7 + 3);
  const transcript =
    `Customer: Hi, this is ${name}. I'm calling because my ${equip} ${sym}. ` +
    `Dispatcher: Hi ${firstName(name)}, I'm sorry to hear that. Can you tell me what brand it is? ` +
    `Customer: It's a ${brand}, ${age}. ` +
    `Dispatcher: Okay, and what's the service address? ` +
    `Customer: ${addr}. ` +
    `Dispatcher: Got it. We can send a technician out ${win}. Does that work? ` +
    `Customer: Yes, that would be great. Thank you.`;
  return {
    id: '', type: 'inbound_call', duration_seconds: 150 + (i % 8) * 15, service_type: t.service_type,
    transcript,
    expected_entities: {
      customer_name: name, issue: `${equip} ${sym}`, equipment: `${brand} ${equip}, ${age}`,
      address: addr, appointment_window: win,
    },
    source: 'synthetic',
  };
}

function emergency(t: TradeSpec, i: number): Transcript {
  const name = pick(NAMES, i + 4);
  const addr = pick(ADDRESSES, i * 2 + 5);
  const equip = pick(t.equipment, i + 1);
  const sym = pick(t.symptoms, i * 3 + 1);
  const transcript =
    `Customer: This is an emergency, my ${equip} ${sym} and it's getting bad! This is ${name} at ${addr}. ` +
    `Dispatcher: Okay ${firstName(name)}, stay calm. I'm getting a technician dispatched to ${addr} right now. ` +
    `Customer: Please hurry. ` +
    `Dispatcher: A tech is on the way, they'll call you when they're close.`;
  return {
    id: '', type: 'inbound_call', duration_seconds: 60 + (i % 5) * 10, service_type: t.service_type,
    transcript,
    expected_entities: {
      customer_name: name, issue: `emergency: ${equip} ${sym}`, equipment: equip,
      address: addr, appointment_window: 'immediate dispatch',
    },
    source: 'synthetic',
  };
}

function reschedule(t: TradeSpec, i: number): Transcript {
  const name = pick(NAMES, i + 2);
  const win = pick(WINDOWS, i + 1);
  const equip = pick(t.equipment, i + 2);
  const transcript =
    `Customer: Hi, this is ${name}. I need to reschedule my appointment for the ${equip}. ` +
    `Dispatcher: No problem ${firstName(name)}. When works better for you? ` +
    `Customer: Could we do ${win}? ` +
    `Dispatcher: That works. I've moved your appointment to ${win}. ` +
    `Customer: Perfect, thanks.`;
  return {
    id: '', type: 'inbound_call', duration_seconds: 70 + (i % 6) * 10, service_type: t.service_type,
    transcript,
    expected_entities: {
      customer_name: name, issue: `reschedule ${equip} appointment`, equipment: equip,
      address: '', appointment_window: win,
    },
    source: 'synthetic',
  };
}

function lookup(t: TradeSpec, i: number): Transcript {
  const name = pick(NAMES, i + 6);
  const equip = pick(t.equipment, i + 3);
  const transcript =
    `Customer: Hi, this is ${name}. I wanted to check on the status of my ${equip} job and what I owe. ` +
    `Dispatcher: Sure ${firstName(name)}, let me pull up your account. ` +
    `Customer: Thank you. ` +
    `Dispatcher: Your ${equip} job is scheduled and your balance is on file. Anything else? ` +
    `Customer: No, that's all.`;
  return {
    id: '', type: 'inbound_call', duration_seconds: 55 + (i % 5) * 10, service_type: t.service_type,
    transcript,
    expected_entities: {
      customer_name: name, issue: `status check on ${equip} job`, equipment: equip,
      address: '', appointment_window: '',
    },
    source: 'synthetic',
  };
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const out: Transcript[] = [];

  // 1. Real seeds
  try {
    for (const f of readdirSync(REAL_SEED_DIR).filter((x) => x.endsWith('.json')).sort()) {
      const seed = JSON.parse(readFileSync(join(REAL_SEED_DIR, f), 'utf8')) as Transcript;
      seed.source = 'real_seed';
      out.push(seed);
    }
  } catch { /* seed dir optional */ }

  // 2. Synthetic, round-robin across trades and templates
  const generators = [booking, emergency, reschedule, lookup];
  let i = 0;
  while (out.length < TARGET) {
    const t = TRADES[i % TRADES.length];
    const gen = generators[Math.floor(i / TRADES.length) % generators.length];
    out.push(gen(t, i));
    i++;
  }

  // 3. Assign ids and write (idempotent: clear prior .json first)
  out.forEach((tr, idx) => { tr.id = `transcript-${String(idx + 1).padStart(3, '0')}`; });
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.json')) unlinkSync(join(OUT_DIR, f));
  }
  for (const tr of out) writeFileSync(join(OUT_DIR, `${tr.id}.json`), JSON.stringify(tr, null, 2) + '\n', 'utf8');

  const byTrade: Record<string, number> = {};
  for (const t of out) byTrade[t.service_type] = (byTrade[t.service_type] ?? 0) + 1;
  const real = out.filter((t) => t.source === 'real_seed').length;
  console.log(`\n🎙️  Wrote ${out.length} transcripts → ${OUT_DIR}`);
  console.log(`   real seeds: ${real}, synthetic: ${out.length - real}`);
  console.log(`   by trade: ${Object.entries(byTrade).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
