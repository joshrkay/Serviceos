/**
 * Offline spike runner:  npx tsx scripts/typesafe-spike/run-spike.ts
 * Always scores the production baselines. Adds the TypeSafe judges only when
 * TYPESAFE_API_KEY is set (this sends the sample utterances to api.typesafe.ai).
 */
import { evaluateBinaryJudge, type BinaryEvalReport, type BinaryJudge } from '../../src/ai/spikes/typesafe/eval-harness';
import { baselineFrustrationJudge, typesafeFrustrationJudge } from '../../src/ai/spikes/typesafe/frustration-judges';
import { baselineComplexityJudge, typesafeComplexityJudge } from '../../src/ai/spikes/typesafe/complexity-judges';
import { COMPLEXITY_SAMPLES, FRUSTRATION_SAMPLES } from '../../src/ai/spikes/typesafe/fixtures';
import { createHttpSystemOneClient } from '../../src/ai/spikes/typesafe/http-client';

function show(name: string, r: BinaryEvalReport): void {
  const c = r.confusion;
  console.log(
    `${name.padEnd(34)} P=${r.precision.toFixed(2)} R=${r.recall.toFixed(2)}  ` +
      `TP=${c.tp} FP=${c.fp} FN=${c.fn} TN=${c.tn}`
  );
  for (const m of r.misses) console.log(`    miss: ${m.text.slice(0, 90)}`);
  for (const m of r.falseAlarms) console.log(`    false alarm: ${m.text.slice(0, 90)}`);
}

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  const run = async (name: string, judge: BinaryJudge, samples: typeof FRUSTRATION_SAMPLES) =>
    show(name, await evaluateBinaryJudge(judge, samples));

  console.log('== Frustration (OR-floor = baseline OR typesafe) ==');
  await run('baseline keyword table', baselineFrustrationJudge, FRUSTRATION_SAMPLES);
  console.log('\n== Complexity ==');
  await run('baseline word-count rule', baselineComplexityJudge, COMPLEXITY_SAMPLES);

  if (!apiKey) {
    console.log('\nTYPESAFE_API_KEY not set — skipping TypeSafe judges.');
    return;
  }
  const client = createHttpSystemOneClient({ apiKey });
  const tsFrustration = typesafeFrustrationJudge(client, { threshold: 0.5 });
  await run('typesafe noul @0.5 (frustration)', tsFrustration, FRUSTRATION_SAMPLES);
  await run('baseline OR typesafe (frustration)', async (t) => {
    const b = await baselineFrustrationJudge(t);
    return b.positive ? b : tsFrustration(t);
  }, FRUSTRATION_SAMPLES);
  await run('typesafe score>=1.5 (complexity)', typesafeComplexityJudge(client, { threshold: 1.5 }), COMPLEXITY_SAMPLES);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
