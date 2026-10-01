/**
 * #1540 §2 — does an unknown caller's ask_caller answer carry a REQUEST?
 *
 * The identify turn carries the caller's request forward into classification
 * so they never repeat themselves. A turn that is only identity ("Casey
 * Rivera, 12 Oak Street", "my name is Jane") has nothing to classify: calling
 * the model for it only adds latency — and with the gateway down, a wait —
 * between the caller and their next words, which may be a hazard report.
 * Such a turn keeps the pre-#1540 behaviour: identify, then "How can I help
 * you today?".
 *
 * Deliberately a CUE check, not a parser: a request almost always carries a
 * need/ask verb, a question, or a service/problem word. A miss is safe — the
 * caller hears "How can I help you today?" and says it again (the old flow);
 * a false hit only costs one classify call. The deterministic E1 scan runs
 * before this on every turn regardless (twilio-adapter.ts
 * runDeterministicSafetyScan).
 */
const REQUEST_CUE = new RegExp(
  [
    // asks and needs
    "\\b(need|needs|want|wanna|like|looking|book|booking|schedule|scheduling|appointment|appt|visit|come|send|call|text|help|question|add|sign(?:ing)? ?up|signup|register|cancel|reschedul\\w*|move|change|confirm|check|update|quote|estimate|invoice|bill|owe|balance|pay|payment|refund|credit)\\b",
    // question words and modal asks
    "\\b(when|what|how|why|where|which|can|could|would|will|is there|do you)\\b",
    // problems and services
    "\\b(fix|repair|replace|install|service|broken|break|leak\\w*|clog\\w*|stopped|won'?t|doesn'?t|isn'?t|not working|emergency|smell\\w*|gas|smoke|fire|water|heat\\w*|cool\\w*|ac|a/c|air|furnace|hvac|plumb\\w*|drain|toilet|pipe\\w*|power|electric\\w*|outlet|tune-?up|maintenance|inspection)\\b",
    // Spanish cues
    "\\b(necesito|quiero|cita|agendar|programar|reparar|arreglar|fuga|ayuda|cancelar|factura|presupuesto)\\b",
  ].join('|'),
  'i',
);

export function askCallerUtteranceCarriesRequest(utterance: string): boolean {
  const text = utterance.trim();
  if (text.length === 0) return false;
  return text.includes('?') || REQUEST_CUE.test(text);
}
