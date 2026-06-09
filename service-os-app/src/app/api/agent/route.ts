import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
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

  // The agent's /process endpoint is gated behind a shared service token
  // (AGENT_SERVICE_TOKEN, fail-closed) and expects the per-tenant `auth_token`
  // it forwards to the Service OS API. Send both, or /process returns 503/401/422.
  const agentServiceToken = process.env.AGENT_SERVICE_TOKEN;
  if (!agentServiceToken) {
    return NextResponse.json({ error: 'Agent service token not configured' }, { status: 500 });
  }
  const { getToken } = await auth();
  const tenantToken = await getToken();
  if (!tenantToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 1. Call the LangGraph agent directly (no n8n in Sprint 1)
  const agentRes = await fetch(`${agentUrl}/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agentServiceToken}`,
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      auth_token: tenantToken,
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
