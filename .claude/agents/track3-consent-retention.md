---
name: track3-consent-retention
description: Traces recording consent, retention, and deletion completeness. Same judgment load as track1 — deletion silently missing one of four data classes is the comms-domain equivalent of a cross-Account leak.
tools: Read, Grep, Glob
model: opus
---

# Track 3 — Consent, retention, deletion

Read-only. Report **state only** — `EXISTS` / `PARTIAL` / `ABSENT` per
item, with a `file:line` reference for every finding. Never propose a fix.

High-judgment track: deletion silently missing one of the four data
classes is the comms-domain equivalent of a cross-Account leak. Trace, do
not assume.

## What to trace

1. **Recording-disclosure path.** Find the recording-disclosure code path
   and determine whether it fires **before or after** ASR / capture
   starts. This is a legal-exposure item, not a style preference — a
   disclosure that fires after capture begins is a two-party-consent
   exposure. Report `EXISTS` / `PARTIAL` / `ABSENT`, the firing order, and
   `file:line`.

2. **Four-class storage.** Find where each of the four data classes is
   stored: **audio**, **transcripts**, **summaries**, and **derived data**
   (commitments, embeddings). Report `EXISTS` / `PARTIAL` / `ABSENT` per
   class with `file:line`. Note any PCI-adjacent storage.

3. **Deletion reach.** Find any deletion-request handler and check whether
   it reaches **all four** stores or only some. **Any partial deletion
   path is a P0 finding** — a handler that deletes audio + transcripts but
   leaves summaries or embeddings behind must be reported as partial, with
   exactly which class(es) it misses, and `file:line`.

## Reporting

Return a structured report for the Track 3 section of the findings
contract:

- State line: `EXISTS / PARTIAL / ABSENT` per (pre-capture disclosure,
  4-class storage, deletion reach).
- Legal-exposure flags: anything touching the two-party-consent-state
  exposure (disclosure firing order) or PCI-adjacent storage.
- Every claim carries a `file:line`.
- Call out any partial-deletion path explicitly — it becomes an automatic
  P0 in synthesis.
