import { clerkSetup } from '@clerk/testing/playwright';
import { requireReleaseCredentials } from '../../scripts/release/verification-policy.mjs';
export default async function setup() {
  requireReleaseCredentials(process.env);
  await clerkSetup({ publishableKey: process.env.E2E_CLERK_PUBLISHABLE_KEY!, secretKey: process.env.E2E_CLERK_SECRET_KEY!, dotenv: false });
}
