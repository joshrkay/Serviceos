# TAXONOMY GAPS

Gap analysis for the 35-behavior voice taxonomy (`data/corpus/behaviors.yaml`).
Per policy, proposed new behaviors are **documented here for Josh to review,
NOT auto-added** to `behaviors.yaml`.

## Unknown-rate measurement

The eval harness records `intent.unknown_rate` — the fraction of held-out
utterances the classifier could not place in any behavior.

| Corpus | Held-out N | Unknown rate | Threshold |
|--------|-----------:|-------------:|-----------|
| utterances (en+es) | 645 | **0.0%** | < 10% |

Unknown rate is 0% because the current corpus is synthetic and generated from
the same taxonomy the classifier keys on. **This number will rise on real
caller traffic** — it is a coverage/wiring check, not a generalization
estimate. Re-run this analysis against held-out human transcripts before
trusting it.

## Candidate behaviors surfaced during authoring

These intents recurred while authoring edge/negative/utterance fixtures and do
not cleanly map to an existing behavior. Each is a **proposal**, with the
fixtures that motivated it. None are added until approved.

| Proposed behavior | Why | Sample utterance | Today it lands in |
|-------------------|-----|------------------|-------------------|
| `warranty_question` | Callers ask if prior work / parts are under warranty | "Is the water heater you put in still under warranty?" | `complaint` or `unknown` |
| `membership_plan` | Maintenance-plan / club enrollment questions | "Do you have one of those yearly service plans?" | `service_availability` |
| `parts_availability` | "Do you have the part in stock / how long to order" | "Do you have the cartridge for a Moen on the truck?" | `unknown` |
| `appointment_eta` | "Where's my tech / how much longer" (distinct from lookup) | "The guy's not here yet, how far out is he?" | `lookup_appointments` |
| `financing_question` | Payment-plan / financing for large jobs | "Do you do financing on a new system?" | `pricing_question` |
| `reschedule_inbound_from_us` | Caller responding to OUR reschedule outreach | "You texted me to move my appointment — yeah that's fine" | `confirm_appointment`/`reschedule_appointment` |
| `language_preference` | Caller asks for service in another language | "¿Hay alguien que hable español?" | `unknown`/`greeting` |

## Recommendation

Promote `warranty_question`, `parts_availability`, and `appointment_eta` first
— they showed the highest authoring friction and have clear, distinct
downstream actions. The remaining four can wait for real-traffic frequency
data. When promoting, add the behavior to `behaviors.yaml`, author EN+ES seed
templates, regenerate, and confirm `eval:full` does not regress.
