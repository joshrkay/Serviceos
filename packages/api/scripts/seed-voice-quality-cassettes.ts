/**
 * Record Layer 1 cassettes for every corpus script using the script-aware
 * mock LLM (no live API keys). Run from packages/api:
 *
 *   npm run voice-quality:seed-cassettes
 */
import { loadCorpus } from '../src/ai/voice-quality/corpus/loader';
import { runScript } from '../src/ai/voice-quality/runner';
import {
  buildCassetteGatewayForScript,
  makeVoiceQualityDriverFactory,
} from '../test/voice-quality/voice-quality-driver-factory';

async function main(): Promise<void> {
  const scripts = loadCorpus().filter((s) => !s.layer2Only);
  if (scripts.length === 0) {
    console.error('No corpus scripts found.');
    process.exit(1);
  }

  let ok = 0;
  for (const script of scripts) {
    const driverFactory = makeVoiceQualityDriverFactory(script, 'record');
    const gatewayFactory = () => buildCassetteGatewayForScript(script, 'record');
    try {
      await runScript(script, {
        driverFactory,
        repoMode: 'memory',
        cassetteMode: 'record',
        gatewayFactory,
      });
      ok++;
      console.log(`recorded: ${script.id}`);
    } catch (err) {
      console.error(`failed: ${script.id}`, err);
      process.exit(1);
    }
  }

  console.log(`Seeded ${ok}/${scripts.length} cassettes.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
