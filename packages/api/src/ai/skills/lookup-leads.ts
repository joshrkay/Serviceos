/**
 * `lookup_leads` voice skill — owner/dispatcher asks how the lead
 * pipeline looks ("how many open leads do we have?").
 *
 * Tenant-scoped (not customer-scoped like the P11-001 lookups): leads
 * are pre-customer records, so the skill reads the tenant's lead list
 * and summarizes open (non-converted, non-lost) leads. Read-only —
 * bypasses the proposals pipeline.
 */
import type { LeadRepository } from '../../leads/lead';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';

export interface LookupLeadsInput {
  tenantId: string;
  sessionId?: string;
}

export interface LookupLeadsDeps {
  leadRepo: LeadRepository;
  lookupEvents?: LookupEventService;
}

export type LookupLeadsResult =
  | { status: 'found'; summary: string; data: { openCount: number } }
  | { status: 'none'; summary: string; data: { openCount: 0 } }
  | { status: 'error'; summary: string; data: { error: string } };

export async function lookupLeads(
  input: LookupLeadsInput,
  deps: LookupLeadsDeps,
): Promise<LookupLeadsResult> {
  const start = Date.now();
  const record = async (
    resultStatus: 'found' | 'none' | 'error',
    resultCount: number,
    summary: string,
  ): Promise<void> => {
    if (!deps.lookupEvents) return;
    try {
      await deps.lookupEvents.record({
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        intent: 'lookup_leads',
        resultStatus,
        resultCount,
        summary,
        latencyMs: Date.now() - start,
      });
    } catch {
      /* swallow — an audit-write failure never breaks the spoken turn */
    }
  };

  try {
    const leads = await deps.leadRepo.findByTenant(input.tenantId);
    const open = leads.filter(
      (l) => l.stage !== 'won' && l.stage !== 'lost' && !l.convertedCustomerId,
    );
    const openCount = open.length;

    if (openCount === 0) {
      const summary = 'There are no open leads in the pipeline right now.';
      await record('none', 0, summary);
      return { status: 'none', summary, data: { openCount: 0 } };
    }
    const noun = openCount === 1 ? 'open lead' : 'open leads';
    const summary = `There ${openCount === 1 ? 'is' : 'are'} ${openCount} ${noun} in the pipeline.`;
    await record('found', openCount, summary);
    return { status: 'found', summary, data: { openCount } };
  } catch (err) {
    const summary = "I'm having trouble pulling up the lead pipeline right now.";
    await record('error', 0, summary);
    return {
      status: 'error',
      summary,
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
