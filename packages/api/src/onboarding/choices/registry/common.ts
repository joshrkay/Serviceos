/**
 * Choice entries shared by every trade. Trade files supply the greeting and
 * price wording; everything else reads the same for a plumber, an HVAC tech
 * or an electrician because the decision is the same.
 */
import type { ChoiceEntry } from '../schema';

export interface TradeVoice {
  /** "plumbing", "heating and cooling", "electrical" — used in support lines. */
  tradeNoun: string;
  /** The emergency a caller describes, in their words, for the emergency card. */
  emergencyExample: string;
  /** What a caller asks when they want a price, for the price card detail. */
  priceAsk: string;
}

export function greetingEntry(): ChoiceEntry {
  return {
    settingKey: 'greeting',
    question: 'How should I answer your phone?',
    supportLine: 'Tap one to hear it. Say "first" or "second" to pick.',
    explain:
      "This is the first thing a caller hears when I pick up your phone. It's in your business's name, so pick the one that sounds like you.",
    example:
      "Someone calls on their lunch break with a problem. The first gets them talking about it right away. The second sounds warmer and takes a breath longer.",
    options: [
      {
        key: 'a',
        label: '{businessName}, how can I help?',
        detail: 'Short. Gets to the problem fast. Callers in a hurry like it.',
        rivetLine: '{businessName}, how can I help?',
        writes: { voiceGreeting: '{businessName}, how can I help?' },
      },
      {
        key: 'b',
        label: "Thanks for calling {businessName}. What's going on today?",
        detail: 'A few more words. Feels like a front desk that knows you.',
        rivetLine: "Thanks for calling {businessName}. What's going on today?",
        writes: { voiceGreeting: "Thanks for calling {businessName}. What's going on today?" },
      },
    ],
    mostShops: 'a',
  };
}

export function priceEntry(v: TradeVoice): ChoiceEntry {
  return {
    settingKey: 'trip_fee_and_rate',
    question: 'What do you charge to come out?',
    supportLine: `This is the first number a caller hears. Here's where ${v.tradeNoun} shops in {city} land.`,
    explain:
      "The trip fee is what a customer pays for you to come out and look. The hourly rate is what the work costs after that. These are the numbers I quote when callers ask.",
    example:
      `Say a caller asks ${v.priceAsk}. With the first, I say it's {tripFee} for the visit, credited toward the repair. With the second, I quote the higher fee on that card: fewer callers book, but the ones who do mean it.`,
    options: [
      {
        key: 'a',
        label: '{tripFee} to come out, then {hourlyRate} an hour',
        detail: `When someone asks ${v.priceAsk}, this is the number I give.`,
        rivetLine: "It's {tripFee} for the visit, and that's credited if you go ahead with the repair.",
        priceTier: 'standard',
        writes: {},
      },
      {
        key: 'b',
        label: '{tripFee} to come out, then {hourlyRate} an hour',
        detail: 'Fewer calls, better ones. Your other prices move up with it.',
        rivetLine: "It's {tripFee} for the visit. That covers the diagnosis, and it's credited toward the repair.",
        priceTier: 'premium',
        writes: {},
      },
    ],
    mostShops: 'a',
  };
}

export function bookingPostureEntry(): ChoiceEntry {
  return {
    settingKey: 'booking_posture',
    question: 'When someone wants a repair, do I book it or hold it for you?',
    supportLine: 'Emergencies skip this. Those always come straight to you.',
    explain:
      "Booking it means I put the job on your calendar while the caller is still on the line. Holding it means I take their details and you pick the time.",
    example:
      "A caller needs a repair this week. With the first, they hang up with Tuesday at 2. With the second, they hear you'll confirm within the hour, and one tap from you texts them the time.",
    options: [
      {
        key: 'a',
        label: 'Book it on the call',
        detail: 'The caller leaves with a time. You get a text and one tap to undo. Nothing gets booked on top of another job.',
        rivetLine: 'I have Tuesday at 2 or Wednesday at 9. Which works for you?',
        writes: { autonomousBookingEnabled: true },
      },
      {
        key: 'b',
        label: 'Hold it for me',
        detail: "I take the details and say you'll confirm within the hour. You tap once and I text the caller.",
        rivetLine: "I've got everything I need. {ownerFirstName} will confirm a time with you within the hour.",
        writes: { autonomousBookingEnabled: false },
      },
    ],
    mostShops: 'a',
  };
}

export function paymentEntry(): ChoiceEntry {
  return {
    settingKey: 'payment_collection_mode',
    question: "When a job's done, how do you want to get paid?",
    supportLine: 'You never have to write a bill. I make it from the job and send it. You just pick how.',
    explain:
      "This is how the customer pays once the work is done. Either way I write the bill from the job, so you never type one up.",
    example:
      "You finish a repair at 3pm. With the first, the customer gets a text with the bill and pays from their phone. With the second, you take payment before you leave and I send the receipt.",
    options: [
      {
        key: 'a',
        label: 'Text them a pay link',
        detail: 'The moment you mark the job done, the customer gets a text with the bill and a pay button. Card or bank.',
        rivetLine: "I'll text you the bill with a pay link as soon as the work is done.",
        writes: { paymentCollectionMode: 'pay_link' },
      },
      {
        key: 'b',
        label: 'Collect on the spot',
        detail: 'You take cash, check or card in the driveway. I send the receipt and keep the books straight.',
        rivetLine: "You can settle up with {ownerFirstName} when the work is done. I'll send your receipt right after.",
        writes: { paymentCollectionMode: 'collect_on_site' },
      },
    ],
    mostShops: 'a',
  };
}

export function bookingHoursEntry(): ChoiceEntry {
  return {
    settingKey: 'booking_hours',
    question: 'When should I put jobs on your calendar?',
    supportLine: "I'll answer every call at any hour either way. This is just when I can book.",
    explain:
      "These are the days and times I can put jobs on your calendar. I still answer every call, at any hour. This only decides when jobs can be booked.",
    example:
      "A caller rings on Saturday morning wanting a visit. With the first, I can book them in that day. With the second, I take their details and book them for Monday.",
    options: [
      {
        key: 'a',
        label: 'Monday to Saturday, 7 to 5',
        detail: 'Six days. Most one-truck shops run this way.',
        rivetLine: 'I can get you on the schedule Monday through Saturday, between 7 and 5.',
        writes: { bookingHoursPreset: 'mon_sat_7_5' },
      },
      {
        key: 'b',
        label: 'Weekdays, 7 to 5',
        detail: 'Weekends stay yours. I take messages and book Monday.',
        rivetLine: 'I can get you on the schedule Monday through Friday, between 7 and 5.',
        writes: { bookingHoursPreset: 'weekdays_7_5' },
      },
    ],
    mostShops: 'a',
  };
}

export function emergencyEntry(v: TradeVoice): ChoiceEntry {
  return {
    settingKey: 'emergency_target',
    question: 'Who do I ring first when it is an emergency?',
    supportLine: `Say a caller tells me "${v.emergencyExample}". Safety first, then a person. That part I always do. This part is yours.`,
    explain:
      "When a caller has a real emergency, I get you on the line fast. This decides how I reach you: a call only, or a call and then a text if you miss it.",
    example:
      `A caller says "${v.emergencyExample}". I tell them how to stay safe, then ring your cell. With the second, if you miss it, I also text you their number and the problem.`,
    options: [
      {
        key: 'a',
        label: 'Your cell, every time',
        detail: "I patch the caller straight through and whisper what's going on before you pick up.",
        rivetLine: "I'm getting {ownerFirstName} on the line for you right now.",
        writes: { emergencyTarget: 'owner_cell' },
      },
      {
        key: 'b',
        label: "Your cell, then text you if you don't pick up",
        detail: "If you miss it, the caller hears you've been paged, and I text you their number and the problem.",
        rivetLine: "I'm trying {ownerFirstName} now. If I can't reach them, I'll page them and they'll call you right back.",
        writes: { emergencyTarget: 'owner_cell_then_text' },
      },
    ],
    mostShops: 'a',
  };
}

export function afterHoursEntry(): ChoiceEntry {
  return {
    settingKey: 'after_hours_mode',
    question: 'Same call at 9pm. Do I answer and book, or take a message?',
    supportLine: 'Either way an emergency still rings you.',
    explain:
      "This is for calls that come in after you've closed for the day. I can still answer and book them a slot, or say you're closed and take a message. Emergencies ring you either way.",
    example:
      "A caller rings at 9pm about a problem that can wait till morning. With the first, they get booked for 8am. With the second, they leave their name and number and you call them first thing.",
    options: [
      {
        key: 'a',
        label: 'Answer and book, any hour',
        detail: 'Most shops. The caller gets a real answer at 9pm and a slot for the morning.',
        rivetLine: 'We can have someone out first thing tomorrow. Does 8am work?',
        writes: { afterHoursVoiceMode: 'ai_answering' },
      },
      {
        key: 'b',
        label: 'Take a message after hours',
        detail: "I answer, say you're closed, and take their name and number for the morning.",
        rivetLine: "We're closed for the evening. Leave your name and number and {ownerFirstName} will call you first thing.",
        writes: { afterHoursVoiceMode: 'voicemail' },
      },
    ],
    mostShops: 'a',
  };
}

export function existingNumberEntry(): ChoiceEntry {
  return {
    settingKey: 'existing_number',
    question: 'Do customers already call a business number?',
    supportLine: "If not, the number I'm about to give you is your business number. Nothing to forward.",
    explain:
      "I'm about to give you a phone number that I answer. If customers already call a different business number, that one needs forwarding to me. If they only call your cell, the new number becomes your business number.",
    example:
      "Say your truck already shows a business number. Pick the second, and I text you a link that forwards it to me. If customers just call your cell, pick the first and put the new number on the truck.",
    options: [
      {
        key: 'a',
        label: 'No, just my cell',
        detail: "Your new number goes on the truck. Calls to it come to me; emergencies come to you.",
        rivetLine: 'You can reach {businessName} any time on this number.',
        writes: { hasExistingBusinessNumber: false },
      },
      {
        key: 'b',
        label: 'Yes, I have a business line',
        detail: "I'll text you a link that forwards it to me in one tap. You can do it later.",
        rivetLine: 'You can reach {businessName} any time on this number.',
        writes: { hasExistingBusinessNumber: true },
      },
    ],
    mostShops: 'a',
  };
}

/** The full registry for a trade, in the order Rivet asks. */
export function buildTradeRegistry(v: TradeVoice): ChoiceEntry[] {
  return [
    greetingEntry(),
    priceEntry(v),
    bookingPostureEntry(),
    paymentEntry(),
    bookingHoursEntry(),
    emergencyEntry(v),
    afterHoursEntry(),
    existingNumberEntry(),
  ];
}
