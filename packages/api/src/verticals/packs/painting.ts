import {
  createVerticalPack,
  type IntakeQuestion,
  type ObjectionScript,
  type ServiceCategory,
  type TerminologyMap,
  type VerticalPack,
} from '../registry';

const PAINTING_CATEGORIES: ServiceCategory[] = [
  { id: 'painting-diagnostic', name: 'Estimate Walk-Through', sortOrder: 1 },
  { id: 'painting-prep', name: 'Surface Prep', sortOrder: 2 },
  { id: 'painting-interior', name: 'Interior Painting', sortOrder: 3 },
  { id: 'painting-exterior', name: 'Exterior Painting', sortOrder: 4 },
  { id: 'painting-specialty', name: 'Specialty Finishes', sortOrder: 5 },
  { id: 'painting-finishing', name: 'Touch-Up and Finish', sortOrder: 6 },
  { id: 'painting-emergency', name: 'Emergency Service', sortOrder: 7 },
];

const PAINTING_TERMINOLOGY: TerminologyMap = {
  bid: {
    displayName: 'Bid',
    aliases: ['quote', 'estimate', 'price', 'proposal'],
  },
  prep: {
    displayName: 'Surface Prep',
    aliases: ['surface preparation', 'sanding', 'scraping', 'patching'],
  },
  primer: {
    displayName: 'Primer',
    aliases: ['undercoat', 'primer coat', 'sealer'],
  },
  sheen: {
    displayName: 'Sheen',
    aliases: ['finish', 'gloss', 'flat', 'eggshell', 'satin', 'semi-gloss'],
  },
  trim: {
    displayName: 'Trim',
    aliases: ['baseboard', 'crown molding', 'casing', 'window trim'],
  },
  cabinet_refinish: {
    displayName: 'Cabinet Refinishing',
    aliases: ['cabinet painting', 'kitchen cabinet paint', 'refinish cabinets'],
  },
  deck_stain: {
    displayName: 'Deck Staining',
    aliases: ['deck stain', 'deck refinish', 'wood stain'],
  },
  lead_paint: {
    displayName: 'Lead Paint',
    aliases: ['lead-based paint', 'pre-1978 paint', 'lead hazard'],
  },
  drywall_repair: {
    displayName: 'Drywall Repair',
    aliases: ['patch', 'hole patch', 'sheetrock repair'],
  },
  caulk: {
    displayName: 'Caulk',
    aliases: ['sealant', 'caulking', 'silicone'],
  },
};

const PAINTING_INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    trigger: 'painting',
    question: 'Is this for interior, exterior, or both?',
    intent: 'service_disambiguation',
  },
  {
    trigger: 'painting',
    question: 'Roughly how many rooms or square feet are we covering?',
    intent: 'scope_sizing',
  },
  {
    trigger: 'lead_paint',
    question: 'Is the home built before 1978? We may need lead-safe procedures.',
    intent: 'safety_triage',
  },
  {
    trigger: 'cabinet_refinish',
    question: 'Are we painting the cabinet boxes only, or doors and drawers as well?',
    intent: 'scope_sizing',
  },
];

const PAINTING_OBJECTION_SCRIPTS: readonly ObjectionScript[] = [
  {
    id: 'phone_quote',
    patterns: ['can you quote it over the phone', 'how much per room', 'just give me a ballpark'],
    reframe:
      'Paint pricing depends on surface condition, prep needed, and ceiling height — we need a quick walk-through to give you a real bid, but the visit is free.',
  },
  {
    id: 'cheaper_competitor',
    patterns: ['other guy is cheaper', 'got a lower bid', 'why are you more expensive'],
    reframe:
      'Most lower bids skip prep — sanding, patching, priming, caulking. Our bid covers the prep that makes the finish last; happy to walk through what is included line by line.',
  },
];

const PAINTING_TRAINING_ASSETS = [
  {
    assetKind: 'intake_question',
    title: 'Painting scope disambiguation',
    scrubbedText:
      'Before proposing a visit, ask whether the work is interior, exterior, or both, and ballpark the room count or square footage.',
    labels: {
      expectedNextQuestion: 'Is this interior, exterior, or both, and roughly how many rooms?',
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-06-17' },
  },
  {
    assetKind: 'intake_question',
    title: 'Pre-1978 lead-paint check',
    scrubbedText:
      'For any home built before 1978, ask about lead-paint disclosure and note that lead-safe procedures may add cost and time.',
    labels: {
      expectedNextQuestion: 'Is the home built before 1978?',
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-06-17' },
  },
  {
    assetKind: 'objection_script',
    title: 'Cheaper competitor reframe',
    scrubbedText:
      'When a caller mentions a lower competing bid, explain that prep work (sanding, patching, priming, caulking) is the difference between a finish that lasts and one that peels in a year.',
    labels: {
      intent: 'objection_reframe',
    },
    provenance: { source: 'synthetic_default', sourceVersion: '2026-06-17' },
  },
];

export function createPaintingPack(): VerticalPack {
  const pack = createVerticalPack(
    'painting',
    'Painting Basic',
    '1.0.0',
    'Second-class painting service pack for residential interior, exterior, and refinishing work',
    PAINTING_CATEGORIES,
    PAINTING_TERMINOLOGY,
    PAINTING_INTAKE_QUESTIONS,
    PAINTING_OBJECTION_SCRIPTS,
  );
  pack.metadata = {
    ...pack.metadata,
    training_tier: 'second_class',
    training_assets: PAINTING_TRAINING_ASSETS,
  };
  pack.sttKeywords = [
    'primer:3',
    'sheen:3',
    'eggshell:3',
    'semi-gloss:3',
    'trim:3',
    'cabinet:3',
    'deck stain:3',
    'drywall patch:3',
    'caulk:3',
    'baseboard:3',
  ];
  pack.repairTemplates = [
    { trigger: 'ambiguous_service_type', text: 'Is this for interior painting, exterior painting, or something like cabinets or a deck?' },
    { trigger: 'low_intent_confidence', text: 'Are you looking for a paint bid, or do you have an issue with paint already on the wall?' },
    { trigger: 'low_audio_confidence', text: "I'm having trouble hearing you — could you say that one more time?" },
    { trigger: 'ambiguous_entity', text: 'Just to make sure I have the right name — could you spell that for me?' },
  ];
  return pack;
}
