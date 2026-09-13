export {
  ADMIN_TASK_INVENTORY,
  ADMIN_TASK_INVENTORY_VERSION,
  inventoryTaskById,
  humanOnlyTasks,
  voiceClaimedTasks,
  type AdminTask,
  type AdminTaskVoiceMode,
} from './inventory';

export {
  computeAdminVoiceCoverage,
  evaluateTask,
  DEFAULT_MIN_VOICE_RATIO,
  DEFAULT_MAX_HUMAN_ONLY_RATIO,
  DEFAULT_SPECIAL_INTENTS,
  type SpeakableCatalogFacts,
  type TaskCoverageResult,
  type AdminVoiceCoverageReport,
} from './coverage';

export { buildSpeakableCatalogFactsFromCode } from './facts-from-code';
