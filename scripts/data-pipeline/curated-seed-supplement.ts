/**
 * curated-seed-supplement.ts — additional HAND-AUTHORED utterances, merged with
 * curated-seed.ts. Same provenance/semantics: source="curated",
 * reviewed_by_human=true (authored & curated by a human-in-the-loop this pass).
 * Kept in a second file purely to keep each file readable.
 */
import type { Seed } from './curated-seed';

export const CURATED_SUPPLEMENT: Record<string, Seed[]> = {
  create_appointment: [
    ['Need a tech for a clogged toilet, this afternoon if possible.', { service_type: 'plumbing', problem_description: 'clogged toilet', time_window: 'this afternoon' }],
    'Set me up for an AC tune up before summer hits.',
    ['Book the electrician for 9 Lakeview Drive, the GFCI keeps tripping.', { address: '9 Lakeview Drive', service_type: 'electrical', problem_description: 'GFCI keeps tripping' }],
  ],
  draft_estimate: [
    'Just want a number on a tankless water heater swap.',
    ['Quote me for replacing all the cast iron drain pipe in the basement.', { service_type: 'plumbing', problem_description: 'replace cast iron drain pipe' }],
    'Can I get a rough estimate over the phone for a new furnace?',
  ],
  create_invoice: [
    'Draw up the bill for the Lakeview job, labor and the float switch.',
    'Invoice them for the after hours rate plus the part.',
  ],
  update_invoice: [
    'Add the haul away fee to that invoice.',
    'Update the invoice, the second tech was there two hours too.',
  ],
  update_estimate: [
    'Revise the quote to add a maintenance plan.',
    'Update the estimate, they want the warranty upgrade.',
  ],
  issue_invoice: [
    'Finalize that one and text them the link.',
    'Issue the invoice for the Lakeview install now.',
  ],
  create_customer: [
    ['Add a customer, Helen Park, 5 River Road, 5552223333.', { name: 'Helen Park', address: '5 River Road', phone: '5552223333' }],
    'Set up the new homeowner who just bought the Miller place.',
  ],
  create_job: [
    'Open a job for the GFCI troubleshooting at Lakeview.',
    'Create the work order for the tankless swap.',
  ],
  reschedule_appointment: [
    ['Can we move it to Saturday morning instead?', { time_window: 'Saturday morning' }],
    'Push my appointment a week, I\'m traveling.',
  ],
  cancel_appointment: [
    'Cancel the Saturday tune up, something came up.',
    'Go ahead and cancel, the landlord is handling it.',
  ],
  reassign_appointment: [
    'Give the Lakeview call to Mike, he\'s closer.',
    'Reassign my last two stops, I\'m running way behind.',
  ],
  add_note: [
    'Note that the customer wants a text before arrival.',
    'Add to the file: water shutoff is in the garage.',
  ],
  send_invoice: [
    'Text the invoice to Helen Park.',
    'Email the bill to the property manager too.',
  ],
  send_estimate: [
    'Send the furnace quote to the customer tonight.',
    'Text the estimate link to the homeowner.',
  ],
  record_payment: [
    ['They paid 600 by card for the install, record it.', { amount: '$600', payment_method: 'card' }],
    'Mark the Lakeview invoice paid, cash.',
  ],
  emergency_dispatch: [
    ['My sump pump failed and the basement is filling with water!', { problem_description: 'sump pump failed, basement flooding', service_type: 'plumbing' }],
    'The furnace is making a loud bang and there\'s a gas smell, help!',
  ],
  update_customer: [
    'Update Helen Park\'s number, she has a new cell.',
    'Change the service address, they moved across town.',
  ],
  log_expense: [
    ['Log 120 for the GFCI breakers at the supply house.', { amount: '$120', expense_category: 'parts' }],
    'Add a fuel expense for the long drive to Lakeview.',
  ],
  convert_lead: [
    'Convert the Miller lead, they\'re ready to book.',
    'They said yes on the furnace, convert the lead.',
  ],
  confirm_appointment: [
    'Just confirming someone\'s coming Saturday morning.',
    'Is the tech still on for my 9 AM?',
  ],
  mark_lead_lost: [
    'Mark the Miller lead lost, they sold the house.',
    'Close that lead, no budget right now.',
  ],
  add_service_location: [
    ['Add the rental at 5 River Road as a second location.', { address: '5 River Road' }],
    'They picked up another property, add the address.',
  ],
  log_time_entry: [
    ['Log three and a half hours on the Lakeview job.', { duration: '3.5 hours' }],
    'Clock me out, total five hours on the install.',
  ],
  notify_delay: [
    'Tell my next stop I\'m running 40 minutes behind.',
    'Let Helen know I\'ll be a little late, parts run.',
  ],
  request_feedback: [
    'Send Helen a review request after today.',
    'Ask the Lakeview customer for a Google review.',
  ],
  lookup_appointments: [
    ['What do I have booked Saturday?', { time_window: 'Saturday' }],
    'Show me everything on the schedule for tomorrow.',
  ],
  lookup_invoices: [
    'Pull the unpaid invoices over 30 days.',
    'Show me Helen Park\'s invoices.',
  ],
  lookup_balance: [
    'How much does Helen Park owe us?',
    'What\'s the balance on the Lakeview job?',
  ],
  lookup_jobs: [
    'Which jobs are waiting on parts right now?',
    'Show me the open work orders for this week.',
  ],
  lookup_agreements: [
    'Is the Miller property on a maintenance plan?',
    'Which agreements renew next month?',
  ],
  lookup_account_summary: [
    'Give me the full summary on Helen Park.',
    'Pull the overview for the Lakeview account.',
  ],
  lookup_customer: [
    ['Look up who\'s at 5 River Road.', { address: '5 River Road' }],
    'Find the customer by this caller ID.',
  ],
  lookup_estimates: [
    'What estimates are still open for the Millers?',
    'Pull the furnace quote we sent last week.',
  ],
  lookup_availability: [
    ['Any openings Saturday morning?', { time_window: 'Saturday morning' }],
    'When\'s the next same day slot for a plumber?',
  ],
  lookup_leads: [
    'How many new leads since yesterday?',
    'Show me leads that need a callback.',
  ],
  lookup_revenue: [
    ['What did we do in revenue last week?', { time_window: 'last week' }],
    'How\'s this month tracking against last?',
  ],
  lookup_catalog: [
    'What\'s the flat rate on a GFCI replacement?',
    'Pull the price for a sump pump install.',
  ],
  language_switch: [
    'Necesito hablar en español, por favor.',
    'Can we continue in English?',
  ],
  operator_request: [
    'Just get me a human, please.',
    'I need to talk to an actual dispatcher.',
  ],
  confirm: [
    'Yes, exactly.',
    'That\'s the one, go ahead.',
  ],
  unknown: [
    'Do you guys do landscaping?',
    'Is this the city water department?',
  ],
};
