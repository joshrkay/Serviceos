/**
 * P2-034 — LLM seam: free-text SMS edit → payload delta.
 *
 * "make it $200" / "change it to Tuesday at 9" → a partial payload object
 * merged over the proposal by `editProposal`. Defense in depth:
 *
 *   1. The model is instructed to return ONLY keys that already exist in
 *      the payload, as strict JSON.
 *   2. We drop any returned key NOT present in the current payload — the
 *      LLM cannot introduce new fields over SMS.
 *   3. `editProposal` Zod-validates the merged payload against the typed
 *      contract for the proposal type — an invalid delta fails closed into
 *      the manual-review reply, never a silent corrupt write.
 *
 * Money note: catalog-grounded prices (P22) are validated by the contract
 * layer; a delta that violates the contract is rejected at step 3. Any
 * failure (provider, JSON, empty delta) returns null — the caller records
 * the request and tells the owner to finish in the review queue.
 */
import type { LLMGateway } from '../../ai/gateway/gateway';
import type { Proposal } from '../proposal';

export const PROPOSAL_SMS_EDIT_TASK_TYPE = 'proposal_sms_edit';

export function createLlmEditInterpreter(
  gateway: Pick<LLMGateway, 'complete'>,
): (args: { proposal: Proposal; instruction: string }) => Promise<Record<string, unknown> | null> {
  return async ({ proposal, instruction }) => {
    try {
      const response = await gateway.complete({
        taskType: PROPOSAL_SMS_EDIT_TASK_TYPE,
        tenantId: proposal.tenantId,
        responseFormat: 'json',
        temperature: 0,
        maxTokens: 600,
        messages: [
          {
            role: 'system',
            content: [
              'You translate a business owner\'s SMS edit instruction into a JSON',
              'object of payload fields to change on a proposal.',
              'Rules:',
              '- Return ONLY a JSON object. No prose, no markdown.',
              '- Include ONLY the fields the instruction changes, with their new values.',
              '- Only use keys that exist in the current payload. Never invent keys.',
              '- All money values are integer cents (e.g. $200 → 20000).',
              '- If the instruction is unclear or changes nothing, return {}.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              proposalType: proposal.proposalType,
              currentPayload: proposal.payload,
              instruction,
            }),
          },
        ],
      });

      const parsed: unknown = JSON.parse(response.content);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      const delta: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (key in proposal.payload) delta[key] = value;
      }
      return Object.keys(delta).length > 0 ? delta : null;
    } catch {
      return null;
    }
  };
}
