import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Deepgram not configured' }, { status: 500 });
  }

  // Generate a short-lived temporary key (30s TTL)
  const res = await fetch('https://api.deepgram.com/v1/auth/token', {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: 30 }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Deepgram token error: ${body}`);
    return NextResponse.json({ error: 'Failed to initialize voice service' }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json({ token: data.key || data.token });
}
