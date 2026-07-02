/**
 * UB-A4 (agent wave) — standing instructions web client.
 *
 * Talks to /api/standing-instructions: persistent owner directives the AI
 * applies when drafting (estimates, invoices, replies). List/add/deactivate
 * only — deactivation is soft so instructions that influenced past drafts
 * stay auditable.
 */
import { apiFetch } from '../utils/api-fetch';

export interface StandingInstructionScope {
  intents?: string[];
  tradeCategories?: string[];
  customerSegment?: 'new' | 'existing' | 'all';
  amountCents?: number;
}

export interface StandingInstruction {
  id: string;
  tenantId: string;
  instruction: string;
  scope: StandingInstructionScope;
  active: boolean;
  /** 'proposal' = created by voice (UB-A2); 'settings' = created here. */
  source: 'proposal' | 'settings';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  deactivatedBy: string | null;
}

export interface StandingInstructionInput {
  instruction: string;
  scope?: StandingInstructionScope;
}

async function readJsonOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json?.message ?? `Failed to ${action}: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listStandingInstructions(): Promise<StandingInstruction[]> {
  const res = await apiFetch('/api/standing-instructions?active=true');
  const data = await readJsonOrThrow<unknown>(res, 'load standing instructions');
  return Array.isArray(data) ? (data as StandingInstruction[]) : [];
}

export async function createStandingInstruction(
  input: StandingInstructionInput,
): Promise<StandingInstruction> {
  const res = await apiFetch('/api/standing-instructions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<StandingInstruction>(res, 'create standing instruction');
}

export async function deactivateStandingInstruction(id: string): Promise<void> {
  const res = await apiFetch(`/api/standing-instructions/${encodeURIComponent(id)}/deactivate`, {
    method: 'PATCH',
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json?.message ?? `Failed to deactivate instruction: ${res.status}`);
  }
}
