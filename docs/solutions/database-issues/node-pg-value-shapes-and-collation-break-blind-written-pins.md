---
title: "node-pg value shapes (NUMERIC as string) and Postgres collation break integration pins written without a live DB"
date: 2026-08-01
track: bug
problem_type: database-issues
module: packages/api/test/integration
tags: ["node-pg", "numeric", "collation", "integration-tests", "testcontainers"]
related: ["docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md"]
---

## Problem
Integration tests written on a machine without Docker (first execution happens in PR CI) failed on real Postgres despite the code under test being correct — the assertions encoded wrong expectations about pg driver and server behavior.

## Symptoms
Two failures in `voicemail-replay-idempotency.test.ts` on its first CI run (PR #791):
1. `duration_seconds` equality failed — column is `NUMERIC` and node-pg returns NUMERIC as a **string** (production code already maps with `Number()` in `pg-voice.ts:19`).
2. An s3_key list compared `ORDER BY s3_key` output against a JS `.sort()` — Postgres linguistic collation orders `….mp3` before `…-voicemail.mp3`; JS code-unit sort orders `-` before `.`.

## What Didn't Work
Assuming driver output mirrors column types, and assuming SQL ordering matches JS ordering. Both pass trivially against in-memory repos; only real Postgres exposes them.

## Solution
Cast in the test's own SELECT (`duration_seconds::int`) and sort both sides with the same JS comparator instead of trusting `ORDER BY` to match. Commits `237fda15`, `f235b194`.

## Why This Works
The pins now assert values in one representation and one ordering domain, independent of driver serialization and server collation.

## Prevention
When writing Docker-gated tests blind: cast NUMERIC/BIGINT to int/float in test SELECTs (or map like production does); never compare a SQL `ORDER BY` list to a JS-sorted list — order both in JS. The companion lesson (mocked-pool doc) covers why the mocked layer can't catch any of this: real columns need real-DB pins, and those pins have their own trap class.
