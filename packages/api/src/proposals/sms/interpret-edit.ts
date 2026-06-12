/**
 * P2-034 — LLM seam: free-text SMS edit → payload delta.
 *
 * RV-225 extracted the implementation to the shared, channel-agnostic
 * `proposals/edit-interpreter.ts` so the voice edit dialogue reuses the
 * exact same seam (same task type, same `_`-prefix stripping, same
 * existing-keys-only filter). This module remains the SMS-facing import
 * path; behavior is byte-identical to the pre-extraction version.
 */
export {
  PROPOSAL_SMS_EDIT_TASK_TYPE,
  createLlmEditInterpreter,
  type ProposalEditInterpreter,
} from '../edit-interpreter';
