/**
 * What Rivet asks the owner to say on the test call. One line per trade, so an
 * HVAC or electrical owner is not told to report a slow drain; the pack id the
 * draft carries decides, and anything else gets the trade-neutral line.
 */
const SCENARIOS: Record<string, string> = {
  plumbing: "Say you've got a slow drain and you're not sure what's wrong. Ask for next Tuesday.",
  hvac: "Say your AC is blowing warm air and you're not sure why. Ask for next Tuesday.",
  electrical: "Say a breaker keeps tripping and you're not sure why. Ask for next Tuesday.",
};

const GENERIC = "Say you've got a problem you'd like looked at. Ask for next Tuesday.";

export function testCallScenario(packId: string | null | undefined): string {
  return (packId && SCENARIOS[packId]) || GENERIC;
}
