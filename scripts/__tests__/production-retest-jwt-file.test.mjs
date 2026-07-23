import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadServiceosJwtFromFile } from '../production-retest.mjs';

test('loadServiceosJwtFromFile accepts a single-line 3-part JWT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-jwt-'));
  const file = path.join(dir, 'token.jwt');
  const jwt = 'aaa.bbb.ccc';
  fs.writeFileSync(file, `${jwt}\n`);
  assert.equal(loadServiceosJwtFromFile(file), jwt);
});

test('loadServiceosJwtFromFile strips wrapping quotes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-jwt-'));
  const file = path.join(dir, 'token.jwt');
  fs.writeFileSync(file, '"aaa.bbb.ccc"\n');
  assert.equal(loadServiceosJwtFromFile(file), 'aaa.bbb.ccc');
});

test('loadServiceosJwtFromFile rejects malformed tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-jwt-'));
  const file = path.join(dir, 'token.jwt');
  fs.writeFileSync(file, 'not-a-jwt\n');
  assert.throws(() => loadServiceosJwtFromFile(file), /3 dot-separated parts/);
});
