import { appendFileSync } from 'node:fs';
import { requireReleaseCredentials } from './verification-policy.mjs';

// Uses the existing GitHub dev environment's project token. Values stay on
// that runner, are masked before use and are never written to artifacts.
try {
  if (!process.env.RAILWAY_TOKEN || !process.env.GITHUB_ENV) throw new Error('GitHub dev environment with RAILWAY_TOKEN is required');
  const response = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Project-Access-Token': process.env.RAILWAY_TOKEN },
    body: JSON.stringify({ query: `query {
      variables(projectId:"a769e9f1-8d94-4491-8c11-5e46fd736f08",
        environmentId:"df7329ef-3709-4dd2-b509-bc1056691916",
        serviceId:"ff349829-f416-4bf5-b4e3-8bfcb2469af1")
    }` }),
  });
  if (!response.ok) throw new Error(`Development credential lookup failed (HTTP ${response.status})`);
  const body = await response.json();
  if (body.errors || !body.data?.variables) throw new Error('Development credential lookup was refused');
  const variables = body.data.variables;
  const keys = {
    E2E_CLERK_PUBLISHABLE_KEY: variables.CLERK_PUBLISHABLE_KEY,
    E2E_CLERK_SECRET_KEY: variables.CLERK_SECRET_KEY,
  };
  requireReleaseCredentials(keys);
  for (const [name, value] of Object.entries(keys)) {
    if (!/^[A-Za-z0-9_=-]+$/.test(value)) throw new Error(`${name} has an unsupported format`);
    console.log(`::add-mask::${value}`);
    appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
  }
  console.log('Development Clerk test keys loaded and masked');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
