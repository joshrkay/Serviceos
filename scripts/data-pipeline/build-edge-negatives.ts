/**
 * build-edge-negatives.ts — emits the hand-authored edge-case and
 * negative/rejection fixture sets with stable ids and build-time validation.
 *
 * Output:
 *   data/corpus/edge_cases.jsonl   (>= 150 rows, every category >= 10)
 *   data/corpus/negatives.jsonl    (>= 50 rows; none may classify as a booking intent)
 *
 * Run: pnpm corpus:fixtures  (runs this + build-slots.ts)
 */
import { join } from 'node:path';
import { CORPUS_DIR, writeJsonl } from './lib';

type Handling = 'route_to_human' | 'clarify' | 'ignore' | 'emergency_dispatch';
const HANDLINGS: ReadonlySet<Handling> = new Set(['route_to_human', 'clarify', 'ignore', 'emergency_dispatch']);

interface EdgeRow {
  id: string;
  text: string;
  category: string;
  expected_handling: Handling;
  lang: 'en' | 'es';
  intent?: string;
  notes: string;
}

type Routing = 'ignore' | 'route_to_human' | 'route_to_careers';
const ROUTINGS: ReadonlySet<Routing> = new Set(['ignore', 'route_to_human', 'route_to_careers']);

interface NegRow {
  id: string;
  text: string;
  category: string;
  not_intent: true;
  expected_routing: Routing;
  lang: 'en';
}

// ── Edge cases ────────────────────────────────────────────────────────────
// Phonetic/disfluent transcripts of the ways callers actually sound. Heavy
// accents are rendered as an ASR-plausible transcript, not mockery; the
// expected handling for the hard accent tail is `clarify` (confidence-gated
// confirm-before-act), which is the safe, non-discriminatory path.
const edge: Array<[string, Handling, string, string?]> = [
  // category, handling, text, optional underlying intent
  // accent_spanish_en (Spanish accent in English) -------------------------
  ['accent_spanish_en', 'clarify', 'Jes, I need somebody for to fix de water heater, eet no make hot water.', 'create_job'],
  ['accent_spanish_en', 'clarify', 'Hallo, my toilet, how you say, eet keep running all de night.', 'create_job'],
  ['accent_spanish_en', 'clarify', 'I want make appointment for de sink, eet is, eh, tapado, blocked.', 'create_appointment'],
  ['accent_spanish_en', 'clarify', 'De man, he no come yesterday, I wait all day, jou understand?', 'complaint'],
  ['accent_spanish_en', 'clarify', 'Can jou send somebody tomorrow morning? My, eh, calentador it broke.', 'create_appointment'],
  ['accent_spanish_en', 'clarify', 'Ees too much money dis bill, I no agree dis price.', 'payment_dispute'],
  ['accent_spanish_en', 'clarify', 'My name ees Carlos, I am new, I need de service for my house.', 'create_customer'],
  ['accent_spanish_en', 'clarify', 'De pipe, eet is broke, water everywhere on de floor, please.', 'emergency_dispatch'],
  ['accent_spanish_en', 'clarify', 'I want pay, eh, de invoice, can I give jou de card number?', 'record_payment'],
  ['accent_spanish_en', 'clarify', 'Jou can come check de air? Eet no cooling, very hot in de house.', 'create_appointment'],
  ['accent_spanish_en', 'clarify', 'How much eet cost for fix de garbage disposal, more or less?', 'pricing_question'],
  ['accent_spanish_en', 'clarify', 'I need cancel, de appointment for tomorrow, I no can be home.', 'cancel_appointment'],
  ['accent_spanish_en', 'clarify', 'My wife she call before, ees under her name, jou find me?', 'lookup_customer'],

  // accent_vietnamese_en --------------------------------------------------
  ['accent_vietnamese_en', 'clarify', 'Hello, my water hee-tah it not working, you come fix today maybe?', 'create_job'],
  ['accent_vietnamese_en', 'clarify', 'I want book appointmen, the sink it leak, drip drip all day.', 'create_appointment'],
  ['accent_vietnamese_en', 'clarify', 'You do the air conditioning? My house too hot, no cool.', 'service_availability'],
  ['accent_vietnamese_en', 'clarify', 'How much money you charge come look, you tell me price?', 'pricing_question'],
  ['accent_vietnamese_en', 'clarify', 'My toilet it keep run, water no stop, can you fix?', 'create_job'],
  ['accent_vietnamese_en', 'clarify', 'I call before, you have my name, I check appointmen time?', 'lookup_appointments'],
  ['accent_vietnamese_en', 'clarify', 'The pipe it burst, water spray everywhere, very fast please!', 'emergency_dispatch'],
  ['accent_vietnamese_en', 'clarify', 'I want cancel the man come tomorrow, no need anymore.', 'cancel_appointment'],
  ['accent_vietnamese_en', 'clarify', 'You send the estimate to my phone, the one for heater?', 'send_estimate'],
  ['accent_vietnamese_en', 'clarify', 'I new customer, never call before, I need set up okay?', 'create_customer'],
  ['accent_vietnamese_en', 'clarify', 'My bill too much, why so much, I no understand the charge.', 'payment_dispute'],
  ['accent_vietnamese_en', 'clarify', 'You change my appointmen to Thursday, Tuesday no good for me.', 'reschedule_appointment'],

  // accent_southern (thick Southern US) -----------------------------------
  ['accent_southern', 'clarify', "Y'all, my commode's been runnin' all night long, drivin' me crazy.", 'create_job'],
  ['accent_southern', 'clarify', "I reckon I need somebody to come look at the warsh machine hookup.", 'create_appointment'],
  ['accent_southern', 'clarify', "The spicket out back is just a-drippin', can ya send a fella out?", 'create_appointment'],
  ['accent_southern', 'clarify', "Well shoot, the hot water heater quit on us this mornin'.", 'create_job'],
  ['accent_southern', 'clarify', "How much y'all charge to come on out and take a look-see?", 'pricing_question'],
  ['accent_southern', 'clarify', "My water pressure ain't worth a hill of beans no more.", 'create_job'],
  ['accent_southern', 'clarify', "I done called twice now and ain't nobody showed up yet.", 'complaint'],
  ['accent_southern', 'clarify', "Fixin' to have folks over, need that toilet fixed 'fore the weekend.", 'create_appointment'],
  ['accent_southern', 'clarify', "The whole dang basement's fillin' up with water, hurry on over!", 'emergency_dispatch'],
  ['accent_southern', 'clarify', "Can ya cancel that appointment? Somethin' come up, bless your heart.", 'cancel_appointment'],
  ['accent_southern', 'clarify', "I'm a new customer, never done business with y'all before.", 'create_customer'],
  ['accent_southern', 'clarify', "Reckon y'all work on them tankless units? My buddy said you might.", 'service_availability'],

  // accent_boston ---------------------------------------------------------
  ['accent_boston', 'clarify', "The wattah heatah is busted, theah's no hot wattah at all.", 'create_job'],
  ['accent_boston', 'clarify', "Can ya send a guy ovah to look at the pipes in the cellah?", 'create_appointment'],
  ['accent_boston', 'clarify', "My toilet's wicked clogged, it's a pissah, can ya come today?", 'create_appointment'],
  ['accent_boston', 'clarify', "The radiatah ain't puttin' out no heat, the apahtment's freezin'.", 'emergency_dispatch'],
  ['accent_boston', 'clarify', "How much ya chahge for a service call ovah by the hahbah?", 'pricing_question'],
  ['accent_boston', 'clarify', "I gotta cancel the appointment, I gotta pahk the cah elsewheah.", 'cancel_appointment'],
  ['accent_boston', 'clarify', "Theah's wattah pourin' outta the ceilin', it's an emahgency!", 'emergency_dispatch'],
  ['accent_boston', 'clarify', "Ya nevah sent me that estimate ya said ya would.", 'send_estimate'],
  ['accent_boston', 'clarify', "I'm lookin' at this bill and it's way too much, no way.", 'payment_dispute'],
  ['accent_boston', 'clarify', "Can ya move my appointment to Thursdee insteada Tuesdee?", 'reschedule_appointment'],
  ['accent_boston', 'clarify', "I'm a new customah, my buddy down the street gave me ya numbah.", 'create_customer'],
  ['accent_boston', 'clarify', "Do yas do the AC units or just the heatin' side a things?", 'service_availability'],

  // accent_ny -------------------------------------------------------------
  ['accent_ny', 'clarify', "Yo, my radiator's bangin' all night, the whole buildin' hears it.", 'create_job'],
  ['accent_ny', 'clarify', "Lemme get a guy out heah, the sink's backed up somethin' awful.", 'create_appointment'],
  ['accent_ny', 'clarify', "Fuhgeddaboudit, the boiler's dead, no heat, it's freezin' in heah.", 'emergency_dispatch'],
  ['accent_ny', 'clarify', "How much you chargin' to come take a look, gimme a ballpawk.", 'pricing_question'],
  ['accent_ny', 'clarify', "I been waitin' all day, wheah's ya guy, this is ridiculous.", 'complaint'],
  ['accent_ny', 'clarify', "Cancel it, awright? I ain't gonna be around tomorrow.", 'cancel_appointment'],
  ['accent_ny', 'clarify', "The pipe burst, theah's wawtah all ovah the apartment, hurry up!", 'emergency_dispatch'],
  ['accent_ny', 'clarify', "Ya gotta send me that invoice, I need it for my records awready.", 'draft_invoice'],
  ['accent_ny', 'clarify', "This bill's outta control, no way it's this much, c'mon.", 'payment_dispute'],
  ['accent_ny', 'clarify', "Push it to Thoisday, Tuesday I got a thing I can't move.", 'reschedule_appointment'],
  ['accent_ny', 'clarify', "I'm new, awright, never used yas before, my super gave me ya numbah.", 'create_customer'],
  ['accent_ny', 'clarify', "You do them tankless heatuhs or nah? My cousin got one a them.", 'service_availability'],

  // emergency_panic -------------------------------------------------------
  ['emergency_panic', 'emergency_dispatch', "oh my god the basement, it's, there's water everywhere, please I don't know what to do!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "it's gushing, it's everywhere, oh my god, the pipe just, it just exploded!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "I smell gas, it's really strong, the whole house, oh god what do I do?!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "the water won't stop, I can't find the shutoff, it's up to my ankles!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "there's sewage, it's coming up the tub, oh my god the smell, please hurry!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "the carbon monoxide thing is screaming, the kids are here, I'm scared!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "no no no it's flooding the whole kitchen, I turned it and it got worse!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "please somebody, the ceiling's bulging and dripping, it's gonna come down!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "it's freezing, the heat's totally dead and the baby's room is ice cold!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "there's sparks and a burning smell from the furnace, I shut it off, help!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "the water heater's hissing and there's water spraying out the top, oh god!", 'emergency_dispatch'],
  ['emergency_panic', 'emergency_dispatch', "damn it the main line backed up, it's all over the floor, I need someone NOW!", 'emergency_dispatch'],

  // code_switch (English <-> Spanish mid-utterance) -----------------------
  ['code_switch', 'clarify', "necesito un plumber, the water heater no funciona, can you come today?", 'create_appointment'],
  ['code_switch', 'clarify', "el AC no está working and it's super hot, can you send somebody?", 'create_appointment'],
  ['code_switch', 'clarify', "my toilet está tapado otra vez, the same one you fixed last month.", 'complaint'],
  ['code_switch', 'clarify', "quiero hacer una cita para el sink, it's leaking under the cabinet.", 'create_appointment'],
  ['code_switch', 'clarify', "cuánto cuesta, like, how much for a service call más o menos?", 'pricing_question'],
  ['code_switch', 'clarify', "necesito cancelar, I mean cancel, the appointment de mañana.", 'cancel_appointment'],
  ['code_switch', 'clarify', "the pipe se reventó, water everywhere, ayúdenme please!", 'emergency_dispatch'],
  ['code_switch', 'clarify', "me pueden mandar el estimate, the one for the calentador?", 'send_estimate'],
  ['code_switch', 'clarify', "soy cliente nuevo, I'm new, necesito set up an account.", 'create_customer'],
  ['code_switch', 'clarify', "this bill está muy caro, way too much, no es correcto.", 'payment_dispute'],
  ['code_switch', 'clarify', "can you move la cita to Thursday? el martes no puedo.", 'reschedule_appointment'],
  ['code_switch', 'clarify', "do you guys hacen el trabajo on tankless, los de gas?", 'service_availability'],

  // background_noise (interfering sounds described in transcript) ----------
  ['background_noise', 'clarify', "[kids screaming] sorry — can you, [crying] — send someone for the heater?", 'create_appointment'],
  ['background_noise', 'clarify', "[TV blaring] what? oh — yeah I need a, hold on — [tv] — a plumber.", 'create_job'],
  ['background_noise', 'clarify', "[traffic noise] hello? can you hear me? I'm on the highway, my, uh—", 'clarify'],
  ['background_noise', 'clarify', "[construction banging] I SAID the sink is clogged, can you come out?", 'create_appointment'],
  ['background_noise', 'clarify', "[dog barking loudly] hush! sorry, the toilet won't stop running.", 'create_job'],
  ['background_noise', 'clarify', "[restaurant noise] yeah hi, I wanted to ask about, uh, an estimate?", 'draft_estimate'],
  ['background_noise', 'clarify', "[baby crying] I'm so sorry, give me one — the water heater's out.", 'create_job'],
  ['background_noise', 'clarify', "[wind and outdoor noise] hello?? the spigot outside busted, water's—", 'create_job'],
  ['background_noise', 'clarify', "[vacuum running] MOM TURN IT OFF — sorry, can someone come Tuesday?", 'create_appointment'],
  ['background_noise', 'clarify', "[music loud] hold on let me — okay, my AC stopped working today.", 'create_job'],
  ['background_noise', 'clarify', "[phone crackling, bad signal] you're breaking up, the, the drain is—", 'clarify'],
  ['background_noise', 'clarify', "[kids fighting] knock it off — hi, sorry, I need to reschedule.", 'reschedule_appointment'],

  // multi_speaker (someone else interjecting) -----------------------------
  ['multi_speaker', 'clarify', "I need a — (wife: ask about the toilet too!) — yeah and the toilet.", 'create_job'],
  ['multi_speaker', 'clarify', "we want to book — (husband: tell them it's the water heater) — the heater.", 'create_appointment'],
  ['multi_speaker', 'clarify', "hold on — (someone: it's the one in the back) — the back bathroom sink.", 'create_appointment'],
  ['multi_speaker', 'clarify', "how much — (kid: MOM) — one sec — how much for a drain cleaning?", 'pricing_question'],
  ['multi_speaker', 'clarify', "my husband says — (man in background: tell them today!) — can you come today?", 'create_appointment'],
  ['multi_speaker', 'clarify', "(contractor in background: the valve's shot) — my guy says the valve's bad.", 'create_job'],
  ['multi_speaker', 'clarify', "we need to cancel — (wife: no, reschedule it!) — actually reschedule it.", 'reschedule_appointment'],
  ['multi_speaker', 'clarify', "(landlord on speaker) the tenant says there's a leak — can you verify?", 'create_job'],
  ['multi_speaker', 'clarify', "yeah so — (roommate: tell them it flooded!) — okay it kind of flooded.", 'emergency_dispatch'],
  ['multi_speaker', 'clarify', "(two people talking over each other) — sorry — we want an estimate.", 'draft_estimate'],
  ['multi_speaker', 'clarify', "I'm calling for my mom — (mom: ask if Tuesday works) — does Tuesday work?", 'create_appointment'],
  ['multi_speaker', 'clarify', "(coworker: get the account number) — uh what's, what's on our account?", 'lookup_account_summary'],

  // hesitation_repair (self-correction, false starts) ---------------------
  ['hesitation_repair', 'clarify', "I need, no wait, um, can you send someone for the, the water heater? No actually it's the boiler.", 'create_appointment'],
  ['hesitation_repair', 'clarify', "I want to, um, book — no, reschedule, yeah reschedule my, my appointment.", 'reschedule_appointment'],
  ['hesitation_repair', 'clarify', "it's the sink, well, not the sink, the, the thing under it, the trap.", 'create_job'],
  ['hesitation_repair', 'clarify', "can you come Tuesday — actually no — Wednesday, Wednesday's better.", 'create_appointment'],
  ['hesitation_repair', 'clarify', "my name is, uh, it's under, hold on, it's under my wife's, um, Maria.", 'lookup_customer'],
  ['hesitation_repair', 'clarify', "I think it's, like, two hundred? or, no, maybe it was the other quote.", 'lookup_estimates'],
  ['hesitation_repair', 'clarify', "the, the, you know, the disposal, it's, it won't, it just hums.", 'create_job'],
  ['hesitation_repair', 'clarify', "I want to pay — wait, no — first, did my last payment even go through?", 'lookup_invoices'],
  ['hesitation_repair', 'clarify', "send the, um, the estimate — or the invoice? whichever one has the total.", 'clarify'],
  ['hesitation_repair', 'clarify', "cancel — no don't cancel — just, can you move it later in the day?", 'reschedule_appointment'],
  ['hesitation_repair', 'clarify', "it's leaking from, um, somewhere, I don't, I can't tell where exactly.", 'create_job'],
  ['hesitation_repair', 'clarify', "I need someone, like, soon, but, um, not today, maybe, I don't know, tomorrow?", 'create_appointment'],

  // wrong_number (caller wants a different business/person) ----------------
  ['wrong_number', 'ignore', "Is this Joe's Pizza? I wanted to order a large pepperoni.", undefined],
  ['wrong_number', 'ignore', "Hi, is Brenda there? I'm trying to reach Brenda.", undefined],
  ['wrong_number', 'ignore', "Oh, sorry, I think I dialed the wrong number, my bad.", undefined],
  ['wrong_number', 'ignore', "Is this the dentist office? I need to confirm my cleaning.", undefined],
  ['wrong_number', 'ignore', "Wait, who is this? I was calling the pharmacy.", undefined],
  ['wrong_number', 'ignore', "Yeah is this the DMV? I had a question about my registration.", undefined],
  ['wrong_number', 'ignore', "I'm looking for the animal shelter, did I call the right place?", undefined],
  ['wrong_number', 'ignore', "Hello, county clerk's office? I need a copy of a birth certificate.", undefined],
  ['wrong_number', 'ignore', "Sorry, wrong number, I meant to call my doctor.", undefined],
  ['wrong_number', 'ignore', "Is this the school? I'm calling about my kid's absence.", undefined],
  ['wrong_number', 'ignore', "Oh this isn't the cable company? Never mind then.", undefined],
  ['wrong_number', 'ignore', "I think I have the wrong number, is this not the bank?", undefined],

  // butt_dial / no-intent -------------------------------------------------
  ['butt_dial', 'ignore', "...so anyway I told her she was being ridiculous and she just...", undefined],
  ['butt_dial', 'ignore', "[muffled] ...yeah grab the milk too... [rustling] ...no the other one...", undefined],
  ['butt_dial', 'ignore', "[silence, faint background talking, no one addressing the line]", undefined],
  ['butt_dial', 'ignore', "...hahaha did you see that, no way, he did not just...", undefined],
  ['butt_dial', 'ignore', "[keys jingling, pocket noise, indistinct] ...uh huh... uh huh...", undefined],
  ['butt_dial', 'ignore', "...turn left up here, no the next one, the NEXT one...", undefined],
  ['butt_dial', 'ignore', "[child babbling into phone] ...ba ba ba da... [giggling]", undefined],
  ['butt_dial', 'ignore', "...what do you want for dinner, I dunno, whatever's fine...", undefined],
  ['butt_dial', 'ignore', "[TV audio only, no caller speaking to the agent at all]", undefined],
  ['butt_dial', 'ignore', "...and then the game went into overtime, can you believe...", undefined],
  ['butt_dial', 'ignore', "[wind, footsteps, phone clearly in a pocket, muffled]", undefined],
  ['butt_dial', 'ignore', "...no I'm on the phone — wait it's actually calling someone — oops...", undefined],

  // demanding_human / abusive -> route_to_human ---------------------------
  ['escalation_demand', 'route_to_human', "I am not talking to a robot, get me a real person right now.", 'agent_handoff_request'],
  ['escalation_demand', 'route_to_human', "Stop. Human. I want a human. I'm not doing this with a machine.", 'agent_handoff_request'],
  ['escalation_demand', 'route_to_human', "This is the worst service ever, put your manager on the phone.", 'complaint'],
  ['escalation_demand', 'route_to_human', "I've been a customer for ten years and this is how you treat me?", 'complaint'],
  ['escalation_demand', 'route_to_human', "I'm going to sue you people, get me someone in charge immediately.", 'complaint'],
  ['escalation_demand', 'route_to_human', "Are you kidding me with this? Just transfer me to an actual employee.", 'agent_handoff_request'],
  ['escalation_demand', 'route_to_human', "I don't want to talk to AI, I want a person, is that so hard?", 'agent_handoff_request'],
  ['escalation_demand', 'route_to_human', "You charged my card without permission, I want a supervisor NOW.", 'payment_dispute'],
  ['escalation_demand', 'route_to_human', "Forget it, this is useless, just have a manager call me back.", 'complaint'],
  ['escalation_demand', 'route_to_human', "Operator. Operator. Representative. Agent. Get me a person.", 'agent_handoff_request'],
  ['escalation_demand', 'route_to_human', "I demand to speak with the owner about what your tech did.", 'complaint'],
  ['escalation_demand', 'route_to_human', "No more questions, I want to talk to a human being, period.", 'agent_handoff_request'],
];

// ── Negatives (must never classify as a booking intent) ───────────────────
const negatives: Array<[string, Routing, string]> = [
  // telemarketer (>= 10)
  ['telemarketer', 'ignore', "Hi, we're reaching out about your business's eligibility for a lower merchant processing rate."],
  ['telemarketer', 'ignore', "This is an important message regarding your Google business listing, press one to continue."],
  ['telemarketer', 'ignore', "Congratulations! You've been selected for a complimentary marketing consultation."],
  ['telemarketer', 'ignore', "We can get your company on the first page of search results guaranteed, interested?"],
  ['telemarketer', 'ignore', "I'm calling about extending the warranty on your company vehicle fleet."],
  ['telemarketer', 'ignore', "Your business may qualify for up to fifty thousand dollars in working capital."],
  ['telemarketer', 'ignore', "We noticed your business doesn't have a verified profile, I can fix that today."],
  ['telemarketer', 'ignore', "This is a courtesy call about your current credit card processing terms."],
  ['telemarketer', 'ignore', "Hi there, do you have a moment to talk about solar for your facility?"],
  ['telemarketer', 'ignore', "We're offering a special rate on commercial insurance for contractors like you."],
  ['telemarketer', 'ignore', "Press one to speak with a representative about your SEO ranking."],
  ['telemarketer', 'ignore', "I'd love to tell you about our lead generation service for home service businesses."],
  // employment inquiry (>= 10) -> route_to_careers
  ['employment', 'route_to_careers', "Hi, are you guys hiring? I'm a licensed plumber looking for work."],
  ['employment', 'route_to_careers', "I saw you might need techs, do you have any openings?"],
  ['employment', 'route_to_careers', "I wanted to drop off my resume, who handles hiring there?"],
  ['employment', 'route_to_careers', "Do you take apprentices? I just finished my HVAC certification."],
  ['employment', 'route_to_careers', "Are you looking for help? I've got fifteen years in the trade."],
  ['employment', 'route_to_careers', "My son needs a job, do you hire helpers with no experience?"],
  ['employment', 'route_to_careers', "Is there a manager I can talk to about a job application?"],
  ['employment', 'route_to_careers', "I applied online last week, just checking if you're still hiring."],
  ['employment', 'route_to_careers', "Do you offer any kind of paid training program for new techs?"],
  ['employment', 'route_to_careers', "Hey, what's the pay like for a service tech with you guys?"],
  // wrong number (>= 10) -> ignore
  ['wrong_number', 'ignore', "Is this Joe's Pizza? I want to place an order."],
  ['wrong_number', 'ignore', "Hi, I'm trying to reach the orthodontist's office."],
  ['wrong_number', 'ignore', "Did I call the towing company? My car broke down."],
  ['wrong_number', 'ignore', "Is this the vet? My dog needs an appointment."],
  ['wrong_number', 'ignore', "Sorry, I was trying to call my insurance agent."],
  ['wrong_number', 'ignore', "Is this the courthouse? I have jury duty questions."],
  ['wrong_number', 'ignore', "I'm looking for the pharmacy refill line."],
  ['wrong_number', 'ignore', "Wrong number, I meant to dial the gas company."],
  ['wrong_number', 'ignore', "Is this the hair salon? I need to book a cut."],
  ['wrong_number', 'ignore', "Hello, is this the locksmith? I'm locked out of my car."],
  // vendor cold call (>= 10) -> ignore
  ['vendor_cold_call', 'ignore', "Hi, I'm with a uniform supply company, can I send you a catalog?"],
  ['vendor_cold_call', 'ignore', "We supply wholesale fittings and want to set up an account with your shop."],
  ['vendor_cold_call', 'ignore', "This is about your business listing in our local directory."],
  ['vendor_cold_call', 'ignore', "I represent a fleet GPS tracking company, do you manage vehicles?"],
  ['vendor_cold_call', 'ignore', "We do branded apparel and truck wraps, who handles your marketing?"],
  ['vendor_cold_call', 'ignore', "Hi, calling from a payroll services provider, got a quick minute?"],
  ['vendor_cold_call', 'ignore', "Can I speak to whoever buys your tools and equipment?"],
  ['vendor_cold_call', 'ignore', "We offer discounted commercial fuel cards for service fleets."],
  ['vendor_cold_call', 'ignore', "I'd like to talk about advertising your business on our radio spots."],
  ['vendor_cold_call', 'ignore', "This is regarding your eligibility for a new business phone system."],
  // survey (>= 10) -> ignore
  ['survey', 'ignore', "Hi, we're conducting a brief survey about local service providers."],
  ['survey', 'ignore', "Do you have two minutes to answer questions about customer satisfaction?"],
  ['survey', 'ignore', "This is a research call, we're not selling anything, just a few questions."],
  ['survey', 'ignore', "On a scale of one to ten, how likely are you to recommend us?"],
  ['survey', 'ignore', "We're polling small businesses about economic conditions this quarter."],
  ['survey', 'ignore', "Would you participate in a short study about contractor software?"],
  ['survey', 'ignore', "Press one if you'd like to take a brief automated survey."],
  ['survey', 'ignore', "We're gathering feedback for a university research project, interested?"],
  ['survey', 'ignore', "Quick question for our market research: how many trucks do you run?"],
  ['survey', 'ignore', "This call may be used for quality and research purposes, may we begin?"],
  // kids playing with phone (>= 10) -> ignore
  ['kids_playing', 'ignore', "hi hi hi hi mommy's phone hello hello"],
  ['kids_playing', 'ignore', "[child] poop! hahaha poopy phone! [giggles]"],
  ['kids_playing', 'ignore', "is this a dinosaur? rawr! are you a dinosaur?"],
  ['kids_playing', 'ignore', "[toddler mashing buttons] aaaaah beep beep beep"],
  ['kids_playing', 'ignore', "my daddy has a truck. it's red. do you have a truck?"],
  ['kids_playing', 'ignore', "[singing] twinkle twinkle little star... hi!"],
  ['kids_playing', 'ignore', "i'm not supposed to use the phone bye bye [hangs up sounds]"],
  ['kids_playing', 'ignore', "[baby] gaaaa baaa daaa [breathing into receiver]"],
  ['kids_playing', 'ignore', "do you like cookies? i like cookies. mommy! mommy!"],
  ['kids_playing', 'ignore', "[kid] hewwo? hewwo? is anybody dere? hehehe"],
];

function buildEdges(): EdgeRow[] {
  return edge.map(([category, handling, text, intent], i) => {
    if (!HANDLINGS.has(handling)) throw new Error(`bad handling "${handling}" at edge[${i}]`);
    // Life-safety overrides the accent/noise "confirm-before-act" path: any
    // fixture whose underlying intent is an emergency must dispatch.
    const finalHandling: Handling = intent === 'emergency_dispatch' ? 'emergency_dispatch' : handling;
    const lang: 'en' | 'es' = 'en';
    const row: EdgeRow = {
      id: `edge_${String(i + 1).padStart(4, '0')}`,
      text,
      category,
      expected_handling: finalHandling,
      lang,
      notes: category.startsWith('accent_')
        ? 'heavy-accent ASR transcript; confidence-gated confirm-before-act'
        : `${category} fixture`,
    };
    if (intent) row.intent = intent;
    return row;
  });
}

function buildNegatives(): NegRow[] {
  return negatives.map(([category, routing, text], i) => {
    if (!ROUTINGS.has(routing)) throw new Error(`bad routing "${routing}" at neg[${i}]`);
    return {
      id: `neg_${String(i + 1).padStart(4, '0')}`,
      text,
      category,
      not_intent: true as const,
      expected_routing: routing,
      lang: 'en' as const,
    };
  });
}

function assertCategoryFloor(rows: Array<{ category: string }>, floor: number, label: string): void {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const summary = [...counts.entries()].map(([c, n]) => `${c}=${n}`).join(' ');
  for (const [c, n] of counts) {
    if (n < floor) throw new Error(`${label}: category "${c}" has ${n} < ${floor} required`);
  }
  console.error(`[fixtures] ${label}: ${rows.length} rows across ${counts.size} categories | ${summary}`);
}

function main(): void {
  const edges = buildEdges();
  const negs = buildNegatives();
  assertCategoryFloor(edges, 10, 'edge_cases');
  assertCategoryFloor(negs, 10, 'negatives');
  if (edges.length < 150) throw new Error(`edge_cases: ${edges.length} < 150 required`);
  if (negs.length < 50) throw new Error(`negatives: ${negs.length} < 50 required`);
  writeJsonl(join(CORPUS_DIR, 'edge_cases.jsonl'), edges);
  writeJsonl(join(CORPUS_DIR, 'negatives.jsonl'), negs);
  console.error(`[fixtures] wrote ${edges.length} edge cases, ${negs.length} negatives`);
}

main();
