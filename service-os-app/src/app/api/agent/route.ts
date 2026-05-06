import { NextResponse } from 'next/server';
import { getTenantId } from '@/lib/tenant';
import { createServerClient } from '@/lib/supabase';

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { transcript, input_method } = await req.json();
  if (!transcript) return NextResponse.json({ error: 'transcript required' }, { status: 400 });

  const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL;
  if (!agentUrl) {
    return NextResponse.json({ error: 'Agent not configured' }, { status: 500 });
  }

  // 1. Call the LangGraph agent directly (no n8n in Sprint 1)
  const agentRes = await fetch(`${agentUrl}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: tenantId,
      transcript,
      input_method: input_method || 'text',
    }),
  });

  if (!agentRes.ok) {
    const body = await agentRes.text();
    return NextResponse.json(
      { error: `Agent error: ${body}` },
      { status: agentRes.status },
    );
  }

  const proposal = await agentRes.json();

  // 2. Save both messages to Supabase conversations table
  const supabase = createServerClient();
  const confirmationMsg = proposal.confirmation_message
    || proposal.clarification_question
    || 'Got it.';

  await supabase.from('conversations').insert([
    {
      tenant_id: tenantId,
      role: 'contractor',
      content: transcript,
      input_method: input_method || 'text',
    },
    {
      tenant_id: tenantId,
      role: 'assistant',
      content: confirmationMsg,
      input_method: 'text',
      proposal_json: proposal,
      proposal_status: proposal.clarification_needed ? null : 'pending',
    },
  ]);

  return NextResponse.json(proposal);
}
