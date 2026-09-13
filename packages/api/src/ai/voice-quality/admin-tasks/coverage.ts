/**
 * Evaluate admin-task inventory against live speakable facts.
 *
 * Pure over (inventory, catalog facts). No network. Used by the CLI gate
 * and unit tests.
 */
import {
  ADMIN_TASK_INVENTORY,
  ADMIN_TASK_INVENTORY_VERSION,
  type AdminTask,
} from './inventory';

/** Facts derived from live code (injected by the CLI/tests). */
export interface SpeakableCatalogFacts {
  /** Intent → proposal type from INTENT_TO_PROPOSAL_TYPE. */
  intentToProposal: Readonly<Record<string, string>>;
  /** Proposal types with a registered execution handler. */
  handlerProposalTypes: ReadonlySet<string>;
  /**
   * Intents that are read-only lookups (isLookupIntent / starts with lookup_).
   * Usually derived; list here for explicit injection in tests.
   */
  lookupIntents: ReadonlySet<string>;
  /**
   * Special intents handled outside INTENT_TO_PROPOSAL_TYPE
   * (complaint, negotiation, en_route).
   */
  specialIntents: ReadonlySet<string>;
}

export interface TaskCoverageResult {
  task: AdminTask;
  /** True when the task is voice-completable under product rules. */
  voiceCompletable: boolean;
  reason: string;
  /** Resolved proposal type when applicable. */
  resolvedProposalType?: string;
}

export interface AdminVoiceCoverageReport {
  inventoryVersion: string;
  totalTasks: number;
  voiceCompletable: number;
  humanOnly: number;
  /** voiceCompletable / totalTasks — product claim ≥ 0.90. */
  voiceCompletableRatio: number;
  /** humanOnly / totalTasks — must be ≤ 0.10. */
  humanOnlyRatio: number;
  gatePassed: boolean;
  minVoiceRatio: number;
  maxHumanOnlyRatio: number;
  results: TaskCoverageResult[];
  /** Claimed-as-speakable but code facts disagree. */
  brokenSpeakable: TaskCoverageResult[];
  /** Explicit residual human-only task ids. */
  humanOnlyIds: string[];
  summaryLines: string[];
}

export const DEFAULT_MIN_VOICE_RATIO = 0.9;
export const DEFAULT_MAX_HUMAN_ONLY_RATIO = 0.1;

/**
 * Special intents the voice-action-router documents outside INTENT_TO_PROPOSAL_TYPE.
 * Kept as a constant so tests can reuse without importing the full router.
 */
export const DEFAULT_SPECIAL_INTENTS: readonly string[] = [
  'complaint',
  'negotiation',
  'en_route',
];

export function evaluateTask(
  task: AdminTask,
  facts: SpeakableCatalogFacts,
): TaskCoverageResult {
  if (task.mode === 'human_only' || task.humanOnly) {
    if (!task.humanOnly || task.mode !== 'human_only') {
      return {
        task,
        voiceCompletable: false,
        reason: 'inventory inconsistency: humanOnly flag/mode mismatch',
      };
    }
    return {
      task,
      voiceCompletable: false,
      reason: 'explicit human-only residual (≤10% budget)',
    };
  }

  if (task.mode === 'lookup') {
    const ok = task.intents.some((i) => facts.lookupIntents.has(i) || i.startsWith('lookup_'));
    return {
      task,
      voiceCompletable: ok,
      reason: ok
        ? `lookup skill(s): ${task.intents.join(', ')}`
        : `no lookup intent recognized for ${task.intents.join(', ')}`,
    };
  }

  if (task.mode === 'special') {
    const ok = task.intents.some((i) => facts.specialIntents.has(i));
    return {
      task,
      voiceCompletable: ok,
      reason: ok
        ? `special router path: ${task.intents.join(', ')}`
        : `special intent not registered: ${task.intents.join(', ')}`,
    };
  }

  // proposal mode — need intent map + handler (speakable triple)
  if (task.intents.length === 0) {
    return {
      task,
      voiceCompletable: false,
      reason: 'proposal mode with no intents',
    };
  }

  const intent = task.intents[0]!;
  const mapped = facts.intentToProposal[intent];
  if (!mapped) {
    return {
      task,
      voiceCompletable: false,
      reason: `intent '${intent}' missing from INTENT_TO_PROPOSAL_TYPE`,
    };
  }
  if (task.proposalType && task.proposalType !== mapped) {
    return {
      task,
      voiceCompletable: false,
      reason: `proposalType inventory '${task.proposalType}' ≠ code map '${mapped}'`,
      resolvedProposalType: mapped,
    };
  }
  if (!facts.handlerProposalTypes.has(mapped)) {
    return {
      task,
      voiceCompletable: false,
      reason: `proposal type '${mapped}' has no execution handler`,
      resolvedProposalType: mapped,
    };
  }
  return {
    task,
    voiceCompletable: true,
    reason: `speakable triple: ${intent} → ${mapped} + handler`,
    resolvedProposalType: mapped,
  };
}

export function computeAdminVoiceCoverage(
  facts: SpeakableCatalogFacts,
  opts?: {
    inventory?: readonly AdminTask[];
    minVoiceRatio?: number;
    maxHumanOnlyRatio?: number;
  },
): AdminVoiceCoverageReport {
  const inventory = opts?.inventory ?? ADMIN_TASK_INVENTORY;
  const minVoiceRatio = opts?.minVoiceRatio ?? DEFAULT_MIN_VOICE_RATIO;
  const maxHumanOnlyRatio = opts?.maxHumanOnlyRatio ?? DEFAULT_MAX_HUMAN_ONLY_RATIO;

  const results = inventory.map((t) => evaluateTask(t, facts));
  const voiceCompletable = results.filter((r) => r.voiceCompletable).length;
  const humanOnly = results.filter((r) => r.task.humanOnly).length;
  const totalTasks = results.length;
  const voiceCompletableRatio = totalTasks === 0 ? 0 : voiceCompletable / totalTasks;
  const humanOnlyRatio = totalTasks === 0 ? 0 : humanOnly / totalTasks;

  const brokenSpeakable = results.filter(
    (r) => !r.task.humanOnly && !r.voiceCompletable,
  );
  const humanOnlyIds = results.filter((r) => r.task.humanOnly).map((r) => r.task.id);

  const gatePassed =
    voiceCompletableRatio + 1e-9 >= minVoiceRatio &&
    humanOnlyRatio - 1e-9 <= maxHumanOnlyRatio &&
    brokenSpeakable.length === 0;

  const summaryLines = [
    `Admin voice coverage v${ADMIN_TASK_INVENTORY_VERSION}: ${voiceCompletable}/${totalTasks} voice-completable (${(voiceCompletableRatio * 100).toFixed(1)}%, need ≥${(minVoiceRatio * 100).toFixed(0)}%)`,
    `Human-only residual: ${humanOnly}/${totalTasks} (${(humanOnlyRatio * 100).toFixed(1)}%, budget ≤${(maxHumanOnlyRatio * 100).toFixed(0)}%) — [${humanOnlyIds.join(', ')}]`,
    `Gate: ${gatePassed ? 'PASS' : 'FAIL'}`,
    ...results.map((r) => {
      const flag = r.voiceCompletable ? '✓' : r.task.humanOnly ? '·' : '✗';
      return `  ${flag} [${r.task.id}] ${r.reason}`;
    }),
  ];

  return {
    inventoryVersion: ADMIN_TASK_INVENTORY_VERSION,
    totalTasks,
    voiceCompletable,
    humanOnly,
    voiceCompletableRatio,
    humanOnlyRatio,
    gatePassed,
    minVoiceRatio,
    maxHumanOnlyRatio,
    results,
    brokenSpeakable,
    humanOnlyIds,
    summaryLines,
  };
}
