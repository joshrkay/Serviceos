#!/usr/bin/env node
/**
 * Generate operator-voice-top-50 v4/v5/v6 case files from v3 structure +
 * per-version utterance lists. Validates 50 cases and distinctness vs prior corpora.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProbeCases } from './probe-operator-voice-50-live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V3_PATH = path.join(ROOT, 'fixtures/voice/operator-voice-top-50-v3-cases.json');
const V2_PATH = path.join(ROOT, 'fixtures/voice/operator-voice-top-50-v2-cases.json');
const LEGACY_PATH = path.join(
  ROOT,
  'docs/verification-runs/operator-voice-50-live-2026-07-20.results.json',
);

const UTTERANCES = {
  v4: [
    'Register homeowner Teresa Flores with mobile 480-555-8801',
    'Onboard client Riley Cooper, email riley@cooper.test',
    'Change Alvarez phone number to 480-555-8802',
    'Set Khan billing email to billing@khan.test',
    'Convert Greenfield Property Management from lead to customer',
    'Update Mrs Lee mailing address to 900 Desert Trail',
    'Pull up the Khan customer account',
    'Promote Greenfield lead to a paying customer',
    'Open a service ticket for Alvarez, AC not cooling',
    'Create a Khan job for garbage disposal repair',
    'Set Johnson water heater job to in progress',
    'Mark Garcia install job as urgent priority',
    'Mark job number twelve complete',
    'Which jobs are on the board today',
    'Quote Khan for a three ton AC unit swap',
    'Build an estimate for Johnson water heater work',
    'Update Khan quote tonnage to three tons',
    'Add duct sealing line item to Khan estimate',
    'Add fifty dollar service call to EST-0001',
    'Email Khan his estimate for review',
    'Send EST-0042 estimate to Garcia by email',
    'Follow up with Khan on the open estimate',
    'Invoice Johnson four hundred fifty for capacitor replacement',
    'Draft a four fifty invoice for Mrs Lee cash job',
    'Add ninety dollar contactor line to Smith invoice',
    'Add twenty five dollar trip fee to invoice INV-0042',
    'Email Johnson his invoice copy',
    'Send invoice INV-0042 to the customer by email',
    'Text Smith the payment link for his invoice',
    'Issue Garcia invoice to billed status',
    'Record four fifty cash payment on Jones invoice',
    'Send Smith a reminder on the overdue invoice',
    'Put Carlos on Garcia Tuesday at two PM',
    'Book Smith for furnace service Tuesday at two PM',
    'Move Garcia Tuesday appointment to Thursday ten AM',
    'Cancel Garcia appointment on Tuesday',
    'Reassign Garcia Tuesday visit to technician Carlos',
    'Confirm Garcia Tuesday service call',
    'Notify Garcia I am twenty minutes behind',
    'What is on the schedule tomorrow',
    'Add note on Patel job — mornings only for visits',
    'Log sixty dollar parts expense against Patel job',
    'Log two hours labor on the Patel job',
    'Emergency no heat at Hayes, dispatch on-call now',
    'Run a batch invoice for all completed jobs',
    'Apply twenty five dollar late fee to Smith account',
    'Send Smith a review request',
    'Standing policy: add seventy nine dollar AC diagnostic always',
    'What balance is still open for Smith',
    'How much revenue have we booked today',
  ],
  v5: [
    'New customer record for Nina Patel, phone 480-555-9901',
    'Add client Owen Blake with email owen@blake.test',
    'Update Alvarez contact phone to 480-555-9902',
    'Change Khan office email to office@khan.test',
    'Add Greenfield Property Management as a customer account',
    'Correct Mrs Lee address to 55 Palo Verde Lane',
    'Look up Khan customer information',
    'Convert Greenfield from sales lead to customer',
    'Start a job for Alvarez — unit not cooling',
    'Open Khan work order for kitchen drain backup',
    'Move Johnson heater job into active work',
    'Escalate Garcia installation to urgent',
    'Complete job twelve in the system',
    'Show today job list',
    'Prepare a quote for Khan three ton condenser changeout',
    'Draft estimate for Johnson on the water heater job',
    'Revise Khan estimate to three ton rating',
    'Append duct seal charge on Khan estimate',
    'Add fifty dollar dispatch fee to estimate EST-0001',
    'Send Khan estimate to customer for approval',
    'Deliver estimate EST-0042 to Garcia',
    'Nudge Khan about the pending estimate again',
    'Create invoice for Johnson four fifty capacitor job',
    'Invoice Mrs Lee four fifty for the cash service call',
    'Post ninety dollar contactor charge on Smith bill',
    'Append twenty five trip fee to INV-0042',
    'Send Johnson invoice to the customer',
    'Forward INV-0042 invoice by email',
    'SMS Smith his invoice payment link',
    'Issue the Garcia invoice now',
    'Apply four fifty cash payment to Jones invoice',
    'Payment reminder for Smith overdue invoice',
    'Assign Carlos to Garcia Tuesday two in the afternoon',
    'Schedule Smith furnace check Tuesday at two PM',
    'Reschedule Garcia Tuesday to Thursday at ten AM',
    'Remove Garcia Tuesday from the calendar',
    'Switch Garcia Tuesday appointment to Carlos',
    'Confirm the Garcia Tuesday booking',
    'Text Garcia that I am twenty minutes late',
    'Tomorrow schedule overview please',
    'Job note for Patel — customer wants morning slots',
    'Expense sixty dollars parts on Patel job',
    'Time entry two hours on Patel job today',
    'Hayes no heat emergency — page on-call immediately',
    'Batch invoice everything completed this week',
    'Charge Smith a twenty five dollar late penalty',
    'Request feedback from Smith after the job',
    'Always include seventy nine dollar diagnostic on AC calls going forward',
    'Tell me Smith outstanding AR balance',
    'Today total revenue snapshot',
  ],
  v6: [
    'Create client profile for Harper Quinn, phone 480-555-6601',
    'Enter customer Blake Turner, email blake@turner.test',
    'Fix Alvarez mobile to 480-555-6602',
    'Update Khan email to service@khan.test',
    'Make Greenfield Property Management a full customer',
    'Change Mrs Lee service location to 120 Mesquite Court',
    'Open Khan customer summary',
    'Turn Greenfield lead into customer record',
    'New Alvarez job for AC failure no cooling',
    'Khan job for disposal line clog repair',
    'Johnson water heater job status to in progress please',
    'Raise Garcia install priority to urgent',
    'Mark job twelve as done',
    'Jobs scheduled for today please',
    'Estimate Khan for three ton condenser install',
    'Quote Johnson water heater replacement job',
    'Adjust Khan estimate to three tons capacity',
    'Include duct sealing on Khan estimate lines',
    'Tack fifty dollar service fee onto EST-0001',
    'Push Khan estimate out to customer',
    'Email Garcia estimate number EST-0042',
    'Second reminder to Khan on open estimate',
    'Draft Johnson invoice four fifty for capacitor work',
    'Four fifty invoice for Mrs Lee same-day cash job',
    'Invoice line ninety dollar contactor for Smith',
    'Twenty five dollar trip on INV-0042 please',
    'Deliver Johnson invoice to client',
    'Email out invoice INV-0042',
    'Send Smith invoice link by text message',
    'Officially issue Garcia invoice',
    'Post cash payment four fifty on Jones invoice',
    'Overdue invoice reminder for Smith',
    'Book Carlos on Garcia Tuesday at two',
    'Smith furnace maintenance Tuesday two PM please',
    'Shift Garcia Tuesday slot to Thursday ten AM',
    'Delete Garcia Tuesday appointment',
    'Give Garcia Tuesday appointment to Carlos',
    'Please confirm Garcia Tuesday visit',
    'Let Garcia know I am running twenty minutes late',
    'What appointments do I have tomorrow',
    'Patel job note — only schedule mornings',
    'Record sixty dollar materials expense on Patel',
    'Two hour time log on Patel job',
    'Hayes home has no heat — emergency dispatch now',
    'Invoice batch for completed jobs today',
    'Smith gets twenty five dollar late charge',
    'Get a review from Smith please',
    'Policy going forward add seventy nine AC diagnostic fee',
    'Smith open balance inquiry',
    'Revenue total for today please',
  ],
};

function priorUtteranceSet(extraPaths = []) {
  const set = new Set();
  for (const sourcePath of [LEGACY_PATH, V2_PATH, V3_PATH, ...extraPaths]) {
    if (!fs.existsSync(sourcePath)) continue;
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    for (const row of loadProbeCases(source)) {
      set.add(row.utterance.trim().toLowerCase());
    }
  }
  return set;
}

function writeCorpus(version, utterances) {
  const template = JSON.parse(fs.readFileSync(V3_PATH, 'utf8'));
  if (utterances.length !== 50) {
    throw new Error(`${version}: expected 50 utterances, got ${utterances.length}`);
  }
  const outPath = path.join(ROOT, `fixtures/voice/operator-voice-top-50-${version}-cases.json`);
  const priorPaths = Object.keys(UTTERANCES)
    .filter((v) => v < version)
    .map((v) => path.join(ROOT, `fixtures/voice/operator-voice-top-50-${v}-cases.json`));
  const prior = priorUtteranceSet(priorPaths);

  const cases = template.cases.map((row, index) => {
    const utterance = utterances[index];
    const key = utterance.trim().toLowerCase();
    if (prior.has(key)) {
      throw new Error(`${version} case #${row.id} duplicates prior corpus: ${utterance}`);
    }
    prior.add(key);
    return { ...row, utterance };
  });

  const ordinals = { v4: 'fourth', v5: 'fifth', v6: 'sixth' };
  const payload = {
    version,
    label: `Operator Voice Top-50 — ${ordinals[version]} utterance set`,
    created: '2026-07-22',
    description: `${ordinals[version][0].toUpperCase()}${ordinals[version].slice(1)} independent 50-workflow corpus. Same ops and fixture alignment as v1–v3, with entirely new phrasing.`,
    fixtureCatalog: template.fixtureCatalog,
    cases,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
}

for (const version of ['v4', 'v5', 'v6']) {
  writeCorpus(version, UTTERANCES[version]);
}
