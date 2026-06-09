/**
 * baseline-classifier.ts — deterministic, offline rule-based intent classifier.
 *
 * This is the CI baseline: no network, no model. It is intentionally simple
 * (ordered keyword/regex rules, first match wins) and is NOT the production
 * classifier. Its job is to make the eval harness runnable offline and to act
 * as a regression floor. The production model (intent-classifier.ts via the LLM
 * gateway) is exercised by --live mode and is what must hit >= 0.92.
 *
 * Rules are ordered most-specific → most-general so families like
 * create/update/send/issue/lookup_invoice don't collide.
 */

type Rule = { intent: string; re: RegExp };

const RULES: Rule[] = [
  // emergencies first
  { intent: 'emergency_dispatch', re: /emergency|gas leak|smell(s|) gas|gas smell|rotten eggs|carbon monoxide|co detector|flooding|burst|pouring|spraying everywhere|sparking and smok|on fire|electrical fire|filling with water/i },
  // session signals
  { intent: 'operator_request', re: /real person|a human|live agent|actual (person|dispatcher)|speak (to|with) (a )?(person|someone|human|representative|dispatcher|the owner)|talk to (a |an )?(person|human|real)|get me a human|just get me a/i },
  { intent: 'language_switch', re: /\b(spanish|español|en español|hablo|habla espa|english (please|instead)|switch to (spanish|english)|in english\b)/i },
  // affirmations (short)
  { intent: 'confirm', re: /^(yes|yep|yeah|correct|sounds good|perfect|sí|s[ií] est[aá] bien|go for it|that works|that'?s (right|correct|the one|what i want)|okay,? yeah|ok,? )/i },
  // lookups (read-only) — before mutate verbs
  { intent: 'lookup_balance', re: /balance|what.*\bowe\b|how much.*\bowe\b|owe (you|us)|what do i owe|account.*behind/i },
  { intent: 'lookup_revenue', re: /\brevenue\b|total sales|how much did we (bring|make|do|book)|\bincome\b|what (did )?we collect|average ticket|how('| a)re we doing on revenue/i },
  { intent: 'lookup_availability', re: /availab|open(ing|ings)?\b|next open slot|earliest|same day slot|what times are open|first available|fit me in/i },
  { intent: 'lookup_appointments', re: /(what|show|pull|list|do i have|how many).*(appointment|schedule|calendar|booked|service call|on the calendar)/i },
  { intent: 'lookup_invoices', re: /(show|pull|find|list|what).*(invoice)|invoice history|unpaid invoices|outstanding/i },
  { intent: 'lookup_estimates', re: /(show|pull|find|list|what).*(estimate|quote)|estimate history|pending estimate|open estimate/i },
  { intent: 'lookup_jobs', re: /(show|pull|list|what|status|which).*(job|work order)/i },
  { intent: 'lookup_agreements', re: /agreement|maintenance (plan|contract)|membership|service plan|warranty agreement|on a (maintenance )?plan/i },
  { intent: 'lookup_account_summary', re: /summary|overview|rundown|snapshot|full picture|everything on (this|the)|highlights on/i },
  { intent: 'lookup_catalog', re: /price book|catalog|what do we charge|rate for|flat rate|price (on|for)|what services|standard trip charge/i },
  { intent: 'lookup_leads', re: /(show|pull|list|how many).*(lead)|leads (from|in|that)|new leads/i },
  { intent: 'lookup_customer', re: /(look up|find|search|pull up).*(customer|record|profile|who.?s at|by (the )?phone|caller id)|in the system|already a customer/i },
  // invoice ops
  { intent: 'send_invoice', re: /(send|text|email|resend|forward|shoot|push).*(invoice|bill|payment link)/i },
  { intent: 'issue_invoice', re: /(finalize|issue|release).*(invoice)|invoice.*(issue it|send it out|ready|approved|good)|that one'?s good, issue/i },
  { intent: 'update_invoice', re: /(add|update|change|edit|take|bump|lower).*(invoice|line item|labor.*invoice)/i },
  { intent: 'create_invoice', re: /(create|make|generate|draw up|write up|put together|set up).*(invoice|bill)|\binvoice (the|them|out|for)\b|bill (the|them|out)/i },
  // estimate ops
  { intent: 'send_estimate', re: /(send|text|email|resend|forward).*(estimate|quote|proposal)/i },
  { intent: 'update_estimate', re: /(update|revise|change|edit|add.*to|lower).*(estimate|quote)/i },
  { intent: 'draft_estimate', re: /\bestimate\b|\bquote\b|how much (would|.*cost|for)|ballpark|what would.*charge|price out|cotizaci|cu[aá]nto/i },
  // appointment ops
  { intent: 'notify_delay', re: /running (late|behind)|i'?m (delayed|behind|late)|behind schedule|push.*back an hour|on my way but|tell.*(late|behind)|minutes (late|behind)/i },
  { intent: 'reschedule_appointment', re: /reschedule|move (it|my|the).*(to|appointment)|push (it |my |the |back)|change my appointment|bump (it |me |my )|cambiar.*cita/i },
  { intent: 'cancel_appointment', re: /cancel|scratch my|take me off the schedule|cancelar|don'?t need the tech/i },
  { intent: 'confirm_appointment', re: /confirm|still on|still coming|double check|verify (my|the).*appointment|make sure.*coming|still good for/i },
  { intent: 'reassign_appointment', re: /reassign|put (\w+) on the|different tech|switch the tech|give the .* (to|call)|move that (install|job) (over )?to|hand .* off to/i },
  { intent: 'create_appointment', re: /schedule|book (a |me |the )|set me up|set up (a |an )?appointment|appointment|come (out|over)|send (someone|a tech|a guy|a plumber|an electrician)|get (someone|a guy|a tech) out|agendar|agenda una cita/i },
  // payment
  { intent: 'record_payment', re: /record.*payment|mark.*(paid|invoice .* paid)|take a payment|paid (cash|by (card|check|cash)|half|in full)|venmo|deposit|put down/i },
  // customer ops
  { intent: 'add_service_location', re: /second (address|location)|another (service )?location|add (a |an )?(service )?(address|location)|rental property|another property|second unit|business address as/i },
  { intent: 'update_customer', re: /(update|change|correct|fix).*(phone|email|address|name|number|contact|billing)|got a new number|she got married|spelling of the customer/i },
  { intent: 'create_customer', re: /new customer|add a (customer|client|contact)|create.*(customer|record|profile|account)|set up.*(customer|account|new account)|crear.*cliente|new (client|homeowner)/i },
  // job ops
  { intent: 'create_job', re: /open (a |the )?(job|work order)|create.*(job|work order)|start a job|new job|spin up.*work order|job ticket|new work order/i },
  // misc ops
  { intent: 'add_note', re: /add (a )?note|note that|put (a )?note|note on (the|her|his)|jot down|in the notes|to the (job )?notes|note for the tech/i },
  { intent: 'request_feedback', re: /review (request|link|ask)|google review|leave us a review|feedback|survey|star rating|testimonial|ask.*review/i },
  { intent: 'convert_lead', re: /convert (the |that )?lead|turn (that |the )?lead into|make (them|that prospect|that referral) a customer|lead.*(ready|said yes|paid)/i },
  { intent: 'mark_lead_lost', re: /lead (lost|dead|is dead)|mark.*(lost|lead lost)|lost (that one|the lead|on price)|close (the |out the )?lead|ghosted|tire kicker/i },
  { intent: 'log_expense', re: /log an expense|material expense|spent .* on (parts|the)|fuel expense|log.*(expense|receipt)|expense (to|against) the job|materials cost|permit fee as/i },
  { intent: 'log_time_entry', re: /log .* hours|clock me|clock the|labor time|hours of labor|record .* (hours|time)|time entry|my (time|hours) (on|for)/i },
];

export function classifyBaseline(utterance: string): string {
  for (const { intent, re } of RULES) {
    if (re.test(utterance)) return intent;
  }
  return 'unknown';
}
