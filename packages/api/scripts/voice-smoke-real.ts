#!/usr/bin/env tsx
/**
 * §11 H2 Layer B — daily real-call voice smoke.
 *
 * Places one outbound Twilio call from a staging test number to the
 * staging-deployed inbound number. Polls Twilio until the call completes,
 * then queries the staging DB for a proposal tagged with the call SID.
 * Exits non-zero (which the GitHub Actions workflow turns into a Slack alert)
 * if anything along the chain breaks.
 */
import twilio from 'twilio';
import { Client } from 'pg';

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env var: ${k}`);
  return v;
}

async function main(): Promise<void> {
  const client = twilio(env('TWILIO_ACCOUNT_SID'), env('TWILIO_AUTH_TOKEN'));
  const call = await client.calls.create({
    from: env('TWILIO_TEST_NUMBER_FROM'),
    to: env('TWILIO_TEST_NUMBER_TO'),
    url: env('STAGING_TWIML_URL'),
    timeout: 20,
  });
  console.log(`call placed: SID=${call.sid}`);

  const start = Date.now();
  let status = call.status;
  while (Date.now() - start < 90_000 && status !== 'completed' && status !== 'failed') {
    await new Promise((r) => setTimeout(r, 3_000));
    status = (await client.calls(call.sid).fetch()).status;
    console.log(`  status: ${status}`);
  }
  if (status !== 'completed') {
    throw new Error(`call did not complete: status=${status} (sid=${call.sid})`);
  }

  // Assert a proposal landed in staging DB tagged with this call SID.
  const db = new Client({ connectionString: env('STAGING_DB_URL') });
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, proposal_type FROM proposals
        WHERE payload->>'callSid' = $1
          AND created_at > NOW() - INTERVAL '5 minutes'
        LIMIT 1`,
      [call.sid],
    );
    if (rows.length === 0) {
      throw new Error(`no proposal landed for callSid=${call.sid}`);
    }
    console.log(`proposal landed: id=${rows[0].id} type=${rows[0].proposal_type}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
