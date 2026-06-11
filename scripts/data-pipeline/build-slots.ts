/**
 * build-slots.ts — emits slot-extraction fixtures for address / time / phone /
 * service, each with a normalized gold value the extractor must reproduce.
 *
 * Output: data/corpus/slot_fixtures/{address,time,phone,service}.jsonl
 * Run: pnpm corpus:fixtures
 */
import { join } from 'node:path';
import { CORPUS_DIR, writeJsonl } from './lib';

interface SlotRow {
  id: string;
  text: string;
  slot_type: 'address' | 'time' | 'phone' | 'service';
  expected: { kind: string; value: string };
  lang: 'en';
}

// ── Address ────────────────────────────────────────────────────────────
// kinds: street_address | intersection | landmark | reference
const address: Array<[string, string, string]> = [
  ['123 Main', 'street_address', '123 main'],
  ['123 Main Street', 'street_address', '123 main street'],
  ['one twenty three Main Street', 'street_address', '123 main street'],
  ['456 Oak Avenue', 'street_address', '456 oak avenue'],
  ['four fifty six Oak Ave', 'street_address', '456 oak ave'],
  ['789 Elm Road', 'street_address', '789 elm road'],
  ['seven eighty nine Elm', 'street_address', '789 elm'],
  ['it\'s 12 Cedar Lane', 'street_address', '12 cedar lane'],
  ['twelve Cedar Lane', 'street_address', '12 cedar lane'],
  ['2200 Washington Boulevard', 'street_address', '2200 washington boulevard'],
  ['twenty two hundred Washington', 'street_address', '2200 washington'],
  ['90 Pine Court', 'street_address', '90 pine court'],
  ['ninety Pine Court', 'street_address', '90 pine court'],
  ['345 Maple Drive apartment 2B', 'street_address', '345 maple drive'],
  ['three forty five Maple', 'street_address', '345 maple'],
  ['67 Lincoln Way', 'street_address', '67 lincoln way'],
  ['sixty seven Lincoln Way', 'street_address', '67 lincoln way'],
  ['1500 Park Street', 'street_address', '1500 park street'],
  ['fifteen hundred Park', 'street_address', '1500 park'],
  ['8 Hill Road', 'street_address', '8 hill road'],
  ['123 Main, by the gas station', 'street_address', '123 main'],
  ['456 Oak, right next to the school', 'street_address', '456 oak'],
  ['it\'s 78 Lake Drive, the blue house', 'street_address', '78 lake drive'],
  ['200 River Road, across from the park', 'street_address', '200 river road'],
  ['the house on the corner of Main and Oak', 'intersection', 'main and oak'],
  ['corner of Elm and Cedar', 'intersection', 'elm and cedar'],
  ['where Pine meets Washington', 'intersection', 'pine and washington'],
  ['it\'s at Lincoln and Park', 'intersection', 'lincoln and park'],
  ['the corner of Hill and Lake', 'intersection', 'hill and lake'],
  ['Bridge and Sunset, the gray duplex', 'intersection', 'bridge and sunset'],
  ['the place by the water tower on Cedar', 'landmark', 'place by the water tower on cedar'],
  ['the blue house next to the fire station', 'landmark', 'blue house next to the fire station'],
  ['behind the strip mall on Maple', 'landmark', 'behind the strip mall on maple'],
  ['the property across from the high school', 'landmark', 'property across from the high school'],
  ['same address as last time', 'reference', 'same_as_on_file'],
  ['the same place you came before', 'reference', 'same_as_on_file'],
  ['it\'s the address you have on file', 'reference', 'same_as_on_file'],
  ['same as my account', 'reference', 'same_as_on_file'],
  ['the usual address', 'reference', 'same_as_on_file'],
  ['my home address you already have', 'reference', 'same_as_on_file'],
  ['the rental, same as before', 'reference', 'same_as_on_file'],
  ['33 Drive', 'street_address', '33 drive'],
  ['341 Sunset Lane near the cul de sac', 'street_address', '341 sunset lane'],
  ['nine ninety nine Bridge Street', 'street_address', '999 bridge street'],
  ['100 Lake Ave unit 4', 'street_address', '100 lake ave'],
];

// ── Time ───────────────────────────────────────────────────────────────
// kinds: relative_window | specific_time | constraint_window | open | asap
const time: Array<[string, string, string]> = [
  ['tomorrow morning', 'relative_window', 'tomorrow morning'],
  ['tomorrow afternoon', 'relative_window', 'tomorrow afternoon'],
  ['this afternoon', 'relative_window', 'this afternoon'],
  ['first thing', 'relative_window', 'first thing'],
  ['first thing in the morning', 'relative_window', 'first thing'],
  ['this weekend', 'relative_window', 'this weekend'],
  ['early next week', 'relative_window', 'early next week'],
  ['Monday morning', 'relative_window', 'monday morning'],
  ['Tuesday afternoon', 'relative_window', 'tuesday afternoon'],
  ['next Thursday', 'relative_window', 'next thursday'],
  ['end of the week', 'relative_window', 'end of the week'],
  ['sometime this week', 'relative_window', 'this week'],
  ['Friday at nine', 'specific_time', 'friday 9:00'],
  ['at three o\'clock', 'specific_time', '3:00'],
  ['around 2 PM', 'specific_time', '2:00 pm'],
  ['noon on Wednesday', 'specific_time', 'wednesday 12:00'],
  ['ten thirty tomorrow', 'specific_time', 'tomorrow 10:30'],
  ['eight in the morning', 'specific_time', '8:00 am'],
  ['after 3', 'constraint_window', 'after 3:00'],
  ['after three but before pickup', 'constraint_window', 'after 3:00'],
  ['before noon', 'constraint_window', 'before 12:00'],
  ['anytime after lunch', 'constraint_window', 'after lunch'],
  ['no earlier than ten', 'constraint_window', 'after 10:00'],
  ['has to be before five', 'constraint_window', 'before 5:00'],
  ['between two and four', 'constraint_window', 'between 2:00 and 4:00'],
  ['any time today', 'open', 'today'],
  ['whenever you can get here', 'open', 'flexible'],
  ['whenever works for you', 'open', 'flexible'],
  ['I\'m flexible', 'open', 'flexible'],
  ['doesn\'t matter when', 'open', 'flexible'],
  ['any day this week is fine', 'open', 'this week'],
  ['ASAP', 'asap', 'asap'],
  ['as soon as possible', 'asap', 'asap'],
  ['right away', 'asap', 'asap'],
  ['as soon as you can', 'asap', 'asap'],
  ['immediately if you can', 'asap', 'asap'],
  ['today if you can', 'relative_window', 'today'],
  ['tomorrow if possible', 'relative_window', 'tomorrow'],
  ['this morning', 'relative_window', 'this morning'],
  ['tonight', 'relative_window', 'tonight'],
  ['Saturday morning', 'relative_window', 'saturday morning'],
  ['the morning works best', 'relative_window', 'morning'],
  ['late afternoon', 'relative_window', 'late afternoon'],
  ['first available', 'asap', 'asap'],
];

// ── Phone ──────────────────────────────────────────────────────────────
// kinds: digits | reference
const phone: Array<[string, string, string]> = [
  ['five five five, one two three, four five six seven', 'digits', '5551234567'],
  ['555 123 4567', 'digits', '5551234567'],
  ['my number is 555-867-5309', 'digits', '5558675309'],
  ['it\'s five five five eight six seven five three oh nine', 'digits', '5558675309'],
  ['area code 415, then 555 0123', 'digits', '4155550123'],
  ['four one five, five five five, oh one two three', 'digits', '4155550123'],
  ['you can reach me at 312 555 7788', 'digits', '3125557788'],
  ['three one two five five five seven seven eight eight', 'digits', '3125557788'],
  ['call me at 555 4321, no area code needed', 'digits', '5554321'],
  ['five five five four three two one', 'digits', '5554321'],
  ['my cell is 646 555 9090', 'digits', '6465559090'],
  ['six four six five five five nine oh nine oh', 'digits', '6465559090'],
  ['it\'s 207 555 1212', 'digits', '2075551212'],
  ['two oh seven, five five five, one two one two', 'digits', '2075551212'],
  ['718 555 0147', 'digits', '7185550147'],
  ['seven one eight five five five oh one four seven', 'digits', '7185550147'],
  ['number is nine one seven five five five two three four five', 'digits', '9175552345'],
  ['917 555 2345', 'digits', '9175552345'],
  ['my number\'s 503 555 6789', 'digits', '5035556789'],
  ['five oh three five five five six seven eight nine', 'digits', '5035556789'],
  ['617 555 4400', 'digits', '6175554400'],
  ['six one seven, five five five, four four zero zero', 'digits', '6175554400'],
  ['it is 305 555 8123', 'digits', '3055558123'],
  ['three oh five five five five eight one two three', 'digits', '3055558123'],
  ['you can reach me at the same number', 'reference', 'same_as_on_file'],
  ['same number you have on file', 'reference', 'same_as_on_file'],
  ['call the number on my account', 'reference', 'same_as_on_file'],
  ['the cell you already have', 'reference', 'same_as_on_file'],
  ['it\'s the same as before', 'reference', 'same_as_on_file'],
  ['use the number I called from', 'reference', 'same_as_caller_id'],
  ['this number I\'m calling from is fine', 'reference', 'same_as_caller_id'],
  ['just call back this line', 'reference', 'same_as_caller_id'],
  ['my number is 480 555 0199', 'digits', '4805550199'],
  ['four eight zero five five five zero one nine nine', 'digits', '4805550199'],
  ['it\'s 615 555 7000', 'digits', '6155557000'],
  ['six one five five five five seven thousand', 'digits', '6155557000'],
  ['872 555 3311', 'digits', '8725553311'],
  ['eight seven two, triple five, three three one one', 'digits', '8725553311'],
  ['reach me on 206 555 4646', 'digits', '2065554646'],
  ['two oh six five five five forty six forty six', 'digits', '2065554646'],
  ['my home phone, 559 555 8080', 'digits', '5595558080'],
  ['five five nine five five five eighty eighty', 'digits', '5595558080'],
  ['the number ending in 4567, the one on file', 'reference', 'same_as_on_file'],
  ['just use my cell on the account', 'reference', 'same_as_on_file'],
];

// ── Service ────────────────────────────────────────────────────────────
// kinds: exact | fuzzy | semantic (matched against the lay vocabulary)
const service: Array<[string, string, string]> = [
  ['my water heater', 'exact', 'water_heater'],
  ['the hot water tank', 'fuzzy', 'water_heater'],
  ['hot water heater', 'fuzzy', 'water_heater'],
  ['no hot water', 'semantic', 'water_heater'],
  ['tankless water heater', 'exact', 'tankless_water_heater'],
  ['the toilet', 'exact', 'toilet'],
  ['the commode', 'fuzzy', 'toilet'],
  ['my toilet keeps running', 'semantic', 'toilet'],
  ['the throne won\'t flush', 'semantic', 'toilet'],
  ['garbage disposal', 'exact', 'garbage_disposal'],
  ['the disposal is jammed', 'fuzzy', 'garbage_disposal'],
  ['the thing that grinds food in the sink', 'semantic', 'garbage_disposal'],
  ['kitchen sink', 'exact', 'sink'],
  ['bathroom sink', 'exact', 'sink'],
  ['the faucet is dripping', 'fuzzy', 'faucet'],
  ['leaky faucet', 'exact', 'faucet'],
  ['the spicket out back', 'semantic', 'outdoor_spigot'],
  ['outdoor spigot', 'exact', 'outdoor_spigot'],
  ['hose bib', 'fuzzy', 'outdoor_spigot'],
  ['the shower', 'exact', 'shower'],
  ['shower valve', 'exact', 'shower_valve'],
  ['the bathtub', 'exact', 'bathtub'],
  ['the tub won\'t drain', 'semantic', 'bathtub'],
  ['main line', 'exact', 'main_line'],
  ['the main sewer line', 'fuzzy', 'sewer_line'],
  ['sewer line', 'exact', 'sewer_line'],
  ['my drain is clogged', 'fuzzy', 'drain'],
  ['clogged drain', 'exact', 'drain'],
  ['the sump pump', 'exact', 'sump_pump'],
  ['well pump', 'exact', 'well_pump'],
  ['the furnace', 'exact', 'furnace'],
  ['no heat from the furnace', 'semantic', 'furnace'],
  ['the AC', 'exact', 'air_conditioner'],
  ['air conditioner', 'exact', 'air_conditioner'],
  ['the air isn\'t cold', 'semantic', 'air_conditioner'],
  ['heat pump', 'exact', 'heat_pump'],
  ['the thermostat', 'exact', 'thermostat'],
  ['the boiler', 'exact', 'boiler'],
  ['ductwork', 'exact', 'ductwork'],
  ['the condenser unit', 'fuzzy', 'condenser'],
  ['gas line', 'exact', 'gas_line'],
  ['water softener', 'exact', 'water_softener'],
  ['the pressure regulator', 'exact', 'pressure_regulator'],
  ['the P trap under the sink', 'fuzzy', 'p_trap'],
  ['that curved pipe under the drain', 'semantic', 'p_trap'],
];

function build(type: SlotRow['slot_type'], rows: Array<[string, string, string]>, prefix: string): SlotRow[] {
  return rows.map(([text, kind, value], i) => ({
    id: `slot_${prefix}_${String(i + 1).padStart(4, '0')}`,
    text,
    slot_type: type,
    expected: { kind, value },
    lang: 'en' as const,
  }));
}

function main(): void {
  const sets: Array<[SlotRow['slot_type'], SlotRow[]]> = [
    ['address', build('address', address, 'addr')],
    ['time', build('time', time, 'time')],
    ['phone', build('phone', phone, 'phone')],
    ['service', build('service', service, 'svc')],
  ];
  for (const [type, rows] of sets) {
    if (rows.length < 25) throw new Error(`slot ${type}: ${rows.length} < 25 (need a real holdout)`);
    writeJsonl(join(CORPUS_DIR, 'slot_fixtures', `${type}.jsonl`), rows);
    console.error(`[slots] ${type}: ${rows.length} fixtures`);
  }
}

main();
