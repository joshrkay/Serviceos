/**
 * SYNTHETIC, hand-labeled by Claude on 2026-10-15 — NOT real caller data and
 * NOT a validated ground truth. Purpose: exercise the harness and surface the
 * obvious gaps. Replace/extend with labeled production transcripts before any
 * accuracy claim is made.
 */
import type { LabeledSample } from './eval-harness';

/** label = true → caller is frustrated / wants a human. */
export const FRUSTRATION_SAMPLES: LabeledSample[] = [
  // literal phrases the keyword table already knows
  { text: 'this is ridiculous', label: true },
  { text: 'I want to talk to a human', label: true },
  { text: "I'm frustrated, this isn't working", label: true },
  { text: 'let me speak to a person', label: true },
  // paraphrases / indirect frustration
  { text: 'I have called three times about this and nobody has shown up', label: true },
  { text: 'Is there an actual human I can reach? Because you are not getting it', label: true },
  { text: 'You keep asking me the same question over and over', label: true },
  { text: "Forget it, I'll find another plumber", label: true },
  { text: 'This is the worst service I have ever dealt with', label: true },
  { text: 'Get me a manager right now', label: true },
  { text: 'Unbelievable. Two hours past the window and no call.', label: true },
  { text: 'No no no, that is not what I said', label: true },
  { text: 'Operator. Operator. OPERATOR.', label: true },
  { text: 'Por favor quiero hablar con una persona de verdad', label: true },
  // neutral / calm — including near-miss vocabulary
  { text: 'my furnace stopped working this morning', label: false },
  { text: 'can I get someone out tomorrow afternoon', label: false },
  { text: 'yes that is correct, 14 Maple Street', label: false },
  { text: 'thanks, that works for me', label: false },
  { text: 'what is the price for a drain cleaning', label: false },
  { text: 'I spoke to a person earlier and they said you would call', label: false },
  { text: 'my neighbor had a real nightmare with their old water heater, so I want to replace mine', label: false },
  { text: 'the AC is not working, it started last night', label: false },
  { text: 'is this the right number for scheduling', label: false },
  { text: 'can you repeat that please', label: false },
  { text: 'yes please send the quote by email', label: false },
  { text: 'It has been a long day, but yes, anytime after four is fine', label: false },
  { text: 'okay, I will wait', label: false },
  { text: 'I would like to reschedule my appointment', label: false },
];

/** label = true → complex (should route to the stronger model). */
export const COMPLEXITY_SAMPLES: LabeledSample[] = [
  // clearly simple
  { text: 'what is on my schedule today', label: false },
  { text: 'who owes me money', label: false },
  { text: 'text the customer I am running late', label: false },
  { text: 'call back the last missed call', label: false },
  { text: 'mark the Garcia job complete', label: false },
  { text: 'what is my revenue this week', label: false },
  { text: 'add a note to the Smith job that the key is under the mat', label: false },
  { text: 'send the invoice', label: false },
  // short but hard (word-count rule misses these)
  { text: 'refund the Hendersons but only the labor, not the part, and cancel the follow-up', label: true },
  { text: 'split the Patel invoice across two cards, half now and half Friday', label: true },
  { text: 'move every job from Tuesday to Thursday except the ones with a permit hold', label: true },
  { text: 'write off the Lopez balance but only if the warranty claim goes through', label: true },
  { text: 'undo the discount I gave Dana yesterday and re-send the estimate', label: true },
  { text: 'combine these two jobs into one visit and bill the second as a callback', label: true },
  { text: 'if the part is not in stock tomorrow reschedule, otherwise keep the slot and tell the tech', label: true },
  // long (word-count rule flags these) — one simple, one genuinely hard
  {
    text:
      'okay so just to confirm I want you to take a look at my schedule and tell me what I have going on for tomorrow ' +
      'morning because I want to know whether I can fit in one more job before lunch if somebody calls and then after ' +
      'that just read me the whole list slowly one by one so I can write it down on the whiteboard in the shop',
    label: false,
  },
  {
    text:
      'the customer on Oak Street disputes the charge because the tech said it was covered under the maintenance ' +
      'agreement but the agreement lapsed last month, so figure out what we should bill, whether a goodwill credit ' +
      'makes sense given the lifetime value, draft the message, and hold the payment retry until I approve',
    label: true,
  },
];
