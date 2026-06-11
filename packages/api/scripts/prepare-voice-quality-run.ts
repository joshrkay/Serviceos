/**
 * Clear verdict shards before a Layer 1 corpus run.
 */
import * as fs from 'fs';
import * as path from 'path';

const VERDICTS_DIR = path.resolve(__dirname, '../.voice-quality-verdicts');

fs.rmSync(VERDICTS_DIR, { recursive: true, force: true });
fs.mkdirSync(VERDICTS_DIR, { recursive: true });
