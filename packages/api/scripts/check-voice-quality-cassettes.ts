/**
 * Fail fast when any voice-quality cassette has no recorded entries.
 * Used before/after cassette refresh to list scripts still needing record.
 */
import * as fs from 'fs';
import * as path from 'path';

const CASSETTES_DIR = path.resolve(
  __dirname,
  '../src/ai/voice-quality/corpus/cassettes',
);

interface CassetteFile {
  scriptId?: string;
  entries?: unknown[];
}

function main(): void {
  const files = fs
    .readdirSync(CASSETTES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const needingRecord: string[] = [];

  for (const file of files) {
    const filePath = path.join(CASSETTES_DIR, file);
    let parsed: CassetteFile;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CassetteFile;
    } catch (err) {
      console.error(`Invalid JSON: ${filePath}`);
      console.error(err);
      process.exit(1);
    }

    const entries = parsed.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      const scriptId =
        typeof parsed.scriptId === 'string'
          ? parsed.scriptId
          : path.basename(file, '.json');
      needingRecord.push(scriptId);
    }
  }

  if (needingRecord.length > 0) {
    console.error(
      `Voice quality cassettes incomplete (${needingRecord.length}/${files.length} need recording):`,
    );
    for (const id of needingRecord) {
      console.error(`  - ${id}`);
    }
    process.exit(1);
  }

  console.log(`All ${files.length} cassettes have recorded entries.`);
}

main();
