import { readFileSync } from 'node:fs';
import { requireReleaseCredentials, verifyReleaseResults } from './verification-policy.mjs';
  try {
    if (process.argv[2] === '--credentials') requireReleaseCredentials(process.env);
    else {
      const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      verifyReleaseResults(report.stats, report.errors);
    }
    console.log('Release verification policy passed');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
