import {
  createVerticalPack,
  type IntakeQuestion,
  type ObjectionScript,
  type ServiceCategory,
  type TerminologyMap,
  type VerticalPack,
} from '../registry';

const ELECTRICAL_CATEGORIES: ServiceCategory[] = [
  { id: 'electrical-diagnostic', name: 'Diagnostic', sortOrder: 1 },
  { id: 'electrical-repair', name: 'Repair', sortOrder: 2 },
  { id: 'electrical-install', name: 'Installation', sortOrder: 3 },
  { id: 'electrical-panel', name: 'Panel and Breaker Work', sortOrder: 4 },
  { id: 'electrical-lighting', name: 'Lighting', sortOrder: 5 },
  { id: 'electrical-safety', name: 'Safety Inspection', sortOrder: 6 },
  { id: 'electrical-emergency', name: 'Emergency Service', sortOrder: 7 },
];

const ELECTRICAL_TERMINOLOGY: TerminologyMap = {
  breaker: {
    displayName: 'Breaker',
    aliases: ['circuit breaker', 'tripping breaker', 'breaker switch'],
  },
  panel: {
    displayName: 'Electrical Panel',
    aliases: ['panel box', 'breaker box', 'service panel', 'main panel'],
  },
  gfci: {
    displayName: 'GFCI Outlet',
    aliases: ['gfci', 'gfi', 'reset outlet', 'bathroom outlet'],
  },
  outlet: {
    displayName: 'Outlet',
    aliases: ['receptacle', 'plug', 'wall outlet'],
  },
  flickering_lights: {
    displayName: 'Flickering Lights',
    aliases: ['lights flicker', 'lights dim', 'lights blinking'],
  },
  burning_smell: {
    displayName: 'Burning Smell',
    aliases: ['burning odor', 'smells hot', 'smoke smell', 'sparks'],
  },
};

const ELECTRICAL_INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    trigger: 'electrical',
    question: 'Is power out in the whole home or only one circuit?',
    intent: 'service_disambiguation',
  },
  {
    trigger: 'safety',
    question: 'Do you smell burning, see sparks, or feel heat near the panel or outlet?',
    intent: 'urgency_triage',
  },
];

const ELECTRICAL_OBJECTION_SCRIPTS: readonly ObjectionScript[] = [
  {
    id: 'phone_quote',
    patterns: ['can you quote it over the phone', 'how much to fix an outlet'],
    reframe:
      'Electrical issues can be unsafe without testing the circuit, so we need a technician to inspect before giving a firm repair price.',
  },
];

const ELECTRICAL_TRAINING_ASSETS = [
  {
    assetKind: 'emergency_rule',
    title: 'Electrical burning smell escalation',
    scrubbedText:
      'If the caller reports burning smell, sparks, smoke, hot panel, or repeated breaker trips, treat as urgent and escalate to a human dispatcher.',
    labels: {
      intent: 'emergency_dispatch',
      urgencyTier: 'emergency',
      expectedNextAction: 'escalate_to_oncall',
      shouldEscalate: true,
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-05-15' },
  },
  {
    assetKind: 'intake_question',
    title: 'Electrical outage disambiguation',
    scrubbedText:
      'Ask whether the outage affects the whole home, one room, or a single outlet before proposing a diagnostic visit.',
    labels: {
      expectedNextQuestion: 'Is power out in the whole home, one room, or only one outlet?',
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-05-15' },
  },
];

export function createElectricalPack(): VerticalPack {
  const pack = createVerticalPack(
    'electrical',
    'Electrical Basic',
    '1.0.0',
    'Second-class electrical service pack for basic residential triage',
    ELECTRICAL_CATEGORIES,
    ELECTRICAL_TERMINOLOGY,
    ELECTRICAL_INTAKE_QUESTIONS,
    ELECTRICAL_OBJECTION_SCRIPTS,
  );
  pack.metadata = {
    ...pack.metadata,
    training_tier: 'second_class',
    training_assets: ELECTRICAL_TRAINING_ASSETS,
  };
  pack.sttKeywords = [
    'breaker:3',
    'panel:3',
    'GFCI:3',
    'sub-panel:3',
    'amperage:3',
    'voltage:3',
    'arc fault:3',
    'romex:3',
    'conduit:3',
    'service entrance:3',
  ];
  pack.repairTemplates = [
    { trigger: 'ambiguous_service_type', text: 'Is this about a power outage, or about installing or fixing wiring?' },
    { trigger: 'low_intent_confidence', text: 'Are you reporting a loss of power, or something else electrical?' },
    { trigger: 'low_audio_confidence', text: "I'm having trouble hearing you — could you say that one more time?" },
    { trigger: 'ambiguous_entity', text: 'Just to make sure I have the right name — could you spell that for me?' },
  ];
  return pack;
}
