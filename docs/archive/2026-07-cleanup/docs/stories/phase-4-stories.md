# Phase 4 — Vertical Packs + Estimate Intelligence

> **26 stories** | Reference: AI Service OS Enhanced Execution PRD

---

## Purpose

Make estimates trade-aware for HVAC/plumbing. Begin improving drafts using vertical context and tenant history.

## Exit Criteria

Packs activated; estimate proposals use pack-specific context; approved history improves drafting.

## Locked Decisions

| Decision | Choice |
|----------|--------|
| Vertical model | Core platform plus activated vertical packs |
| Estimate priority | Line-item suggestions, wording, bundles before autonomous pricing |
| Retrieval | Tenant-approved estimates before generic examples |
| Safety | All estimate outputs remain reviewable and approval-based |

## Story Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P4-001A | Vertical pack registry schema | S | Platform | High | Moderate | None |
| P4-001B | Tenant-to-pack activation linkage | S | Settings | High | Light | P4-001A |
| P4-001C | Vertical pack config loading | S | Platform | Medium | Moderate | P4-001A, P4-001B |
| P4-002A | HVAC terminology map | S | Vertical Pack | High | Moderate | P4-001A |
| P4-002B | HVAC service category taxonomy | S | Vertical Pack | High | Moderate | P4-001A |
| P4-003A | Plumbing terminology map | S | Vertical Pack | High | Moderate | P4-001A |
| P4-003B | Plumbing service category taxonomy | S | Vertical Pack | High | Moderate | P4-001A |
| P4-004A | Vertical estimate template schema | S | Estimate AI | Medium | Heavy | P1-009A, P4-001C |
| P4-004B | Template retrieval by vertical and category | S | Estimate AI | High | Moderate | P4-004A |
| P4-004C | Template provenance tagging | XS | Learning | High | Light | P4-004A, P1-009B |
| P4-005A | Approved-estimate retrieval metadata | S | Learning | Medium | Moderate | P1-009B, P1-009C, P1-009E |
| P4-005B | Tenant-scoped approved-estimate lookup | S | Learning | Medium | Moderate | P4-005A |
| P4-005C | Retrieval-ready estimate summary snapshots | S | Learning | Medium | Moderate | P4-005A, P4-005B |
| P4-006A | Line-item bundle pattern model | S | Learning | Medium | Moderate | P4-005A |
| P4-006B | Bundle suggestions from approved history | S | Learning | Medium | Heavy | P4-006A, P4-005B |
| P4-007A | Tenant wording preference capture | S | Learning | Medium | Moderate | P4-005B |
| P4-007B | Wording preference context injection | XS | Learning | High | Light | P4-007A, P2-008 |
| P4-008A | Repeatedly added line-item detection | S | Learning | Medium | Moderate | P1-009D |
| P4-008B | Missing-item suggestion signals | S | Learning | Medium | Moderate | P4-008A |
| P4-009A | Vertical-aware context assembly | XS | Estimate AI | High | Light | P4-001C, P2-008 |
| P4-009B | Service category + template context assembly | S | Estimate AI | Medium | Moderate | P4-002A, P4-002B, P4-003A, P4-003B, P4-004B, P4-009A |
| P4-009C | History- and signal-aware context assembly | S | Estimate AI | Medium | Heavy | P4-005C, P4-006B, P4-007B, P4-008B, P4-009A |
| P4-010A | Active vertical settings in tenant config | S | Settings | High | Light | P4-001B, P1-017 |
| P4-010B | Terminology preference controls | S | Settings | High | Moderate | P4-010A |
| P4-011A | Vertical-aware estimate quality metric model | S | Analytics | Medium | Moderate | P1-009F, P4-009B |
| P4-012 | Estimate-acceleration beta benchmark | S | Analytics | High | Moderate | P4-011A |

---

## Story Specifications

### P4-001A — Vertical pack registry schema

> **Size:** S | **Layer:** Platform | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** None

**Allowed files:** `packages/api/src/shared/**, packages/api/src/health/**`

**Build prompt:** Create registry model for pack id, version, status, metadata, and vertical type.

**Review prompt:** Review extensibility and whether HVAC/plumbing assumptions leak into the base model.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-001A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-001B — Tenant-to-pack activation linkage

> **Size:** S | **Layer:** Settings | **AI Build:** High | **Human Review:** Light

**Dependencies:** P4-001A

**Allowed files:** `packages/api/src/settings/**`

**Build prompt:** Allow tenants to activate HVAC, plumbing, or both.

**Review prompt:** Review permission safety and future pack combinations.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-001B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-001C — Vertical pack config loading

> **Size:** S | **Layer:** Platform | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P4-001A, P4-001B

**Allowed files:** `packages/api/src/shared/**, packages/api/src/health/**`

**Build prompt:** Load terminology, categories, templates, intake config, and prompt context from active packs.

**Review prompt:** Review override behavior and runtime safety.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-001C"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-002A — HVAC terminology map

> **Size:** S | **Layer:** Vertical Pack | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P4-001A

**Allowed files:** `packages/api/src/verticals/**`

**Build prompt:** Define HVAC terminology for prompts, UI labels, and estimate suggestions.

**Review prompt:** Review consistency and ambiguity.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-002A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-002B — HVAC service category taxonomy

> **Size:** S | **Layer:** Vertical Pack | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P4-001A

**Allowed files:** `packages/api/src/verticals/**`

**Build prompt:** Define HVAC categories such as diagnostic, repair, maintenance, install, replacement, emergency.

**Review prompt:** Review coverage vs beta simplicity.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-002B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-003A — Plumbing terminology map

> **Size:** S | **Layer:** Vertical Pack | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P4-001A

**Allowed files:** `packages/api/src/verticals/**`

**Build prompt:** Define plumbing terminology for prompts, UI labels, and estimate suggestions.

**Review prompt:** Review whether terms are specific enough without overfitting.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-003A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-003B — Plumbing service category taxonomy

> **Size:** S | **Layer:** Vertical Pack | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P4-001A

**Allowed files:** `packages/api/src/verticals/**`

**Build prompt:** Define plumbing categories such as diagnostic, repair, install, replacement, drain, water-heater, emergency.

**Review prompt:** Review coverage and overlap.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-003B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-004A — Vertical estimate template schema

> **Size:** S | **Layer:** Estimate AI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P1-009A, P4-001C

**Allowed files:** `packages/api/src/ai/tasks/**, packages/web/src/components/proposals/estimate-editor.**`

**Build prompt:** Define pack-level estimate template schema with default line items, ordering, notes, and metadata.

**Review prompt:** Review future compatibility and risk of overfitting.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-004A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P4-004B — Template retrieval by vertical and category

> **Size:** S | **Layer:** Estimate AI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P4-004A

**Allowed files:** `packages/api/src/ai/tasks/**, packages/web/src/components/proposals/estimate-editor.**`

**Build prompt:** Retrieve estimate templates by active pack and service category.

**Review prompt:** Review fallback rules and retrieval logic.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-004B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P4-004C — Template provenance tagging

> **Size:** XS | **Layer:** Learning | **AI Build:** High | **Human Review:** Light

**Dependencies:** P4-004A, P1-009B

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Tag estimate suggestions that came from a vertical template.

**Review prompt:** Review consistency with provenance model.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-004C"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-005A — Approved-estimate retrieval metadata

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-009B, P1-009C, P1-009E

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Create metadata contract for approved estimates: tenant, vertical, category, approval outcome, recency, line-item summary.

**Review prompt:** Review whether metadata is enough for later retrieval/ranking.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-005A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-005B — Tenant-scoped approved-estimate lookup

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P4-005A

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Look up prior approved estimates using metadata filters for estimate drafting.

**Review prompt:** Review tenant isolation and usefulness without semantic search.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-005B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-005C — Retrieval-ready estimate summary snapshots

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P4-005A, P4-005B

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Create compact snapshots of approved estimates for prompt/retrieval use.

**Review prompt:** Review usefulness and prompt-efficiency.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-005C"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-006A — Line-item bundle pattern model

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P4-005A

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Represent common co-occurring line-item bundles for tenant and vertical use.

**Review prompt:** Review simplicity and future flexibility.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-006A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-006B — Bundle suggestions from approved history

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P4-006A, P4-005B

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Identify repeated line-item combinations from approved estimate history.

**Review prompt:** Review false positives and whether bundles are actually useful.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-006B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-007A — Tenant wording preference capture

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P4-005B

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Capture preferred line-item wording patterns from approved estimates.

**Review prompt:** Review normalization and overfitting risk.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-007A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-007B — Wording preference context injection

> **Size:** XS | **Layer:** Learning | **AI Build:** High | **Human Review:** Light

**Dependencies:** P4-007A, P2-008

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Expose wording preferences to estimate context assembly.

**Review prompt:** Review whether signal is narrow and useful.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-007B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-008A — Repeatedly added line-item detection

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-009D

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Use estimate edit deltas to identify items users repeatedly add after AI draft generation.

**Review prompt:** Review signal quality and false-positive risk.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-008A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-008B — Missing-item suggestion signals

> **Size:** S | **Layer:** Learning | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P4-008A

**Allowed files:** `packages/api/src/estimates/**, packages/api/src/ai/evaluation/**`

**Build prompt:** Store missing-item signals by tenant, vertical, category, and recency.

**Review prompt:** Review whether the storage model supports ranking later.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-008B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-009A — Vertical-aware context assembly

> **Size:** XS | **Layer:** Estimate AI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P4-001C, P2-008

**Allowed files:** `packages/api/src/ai/tasks/**, packages/web/src/components/proposals/estimate-editor.**`

**Build prompt:** Extend estimate context assembly with active vertical pack metadata.

**Review prompt:** Review minimality and relevance.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-009A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P4-009B — Service category + template context assembly

> **Size:** S | **Layer:** Estimate AI | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P4-002A, P4-002B, P4-003A, P4-003B, P4-004B, P4-009A

**Allowed files:** `packages/api/src/ai/tasks/**, packages/web/src/components/proposals/estimate-editor.**`

**Build prompt:** Add service category, matching template summary, and terminology preferences to estimate context.

**Review prompt:** Review prompt size and relevance.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-009B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P4-009C — History- and signal-aware context assembly

> **Size:** S | **Layer:** Estimate AI | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P4-005C, P4-006B, P4-007B, P4-008B, P4-009A

**Allowed files:** `packages/api/src/ai/tasks/**, packages/web/src/components/proposals/estimate-editor.**`

**Build prompt:** Add approved-estimate references, bundle suggestions, wording preferences, and missing-item signals to estimate context.

**Review prompt:** Review whether context overload becomes a risk.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-009C"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors
- [ ] Mock provider test
- [ ] Malformed AI output handled gracefully

---

### P4-010A — Active vertical settings in tenant config

> **Size:** S | **Layer:** Settings | **AI Build:** High | **Human Review:** Light

**Dependencies:** P4-001B, P1-017

**Allowed files:** `packages/api/src/settings/**`

**Build prompt:** Add active pack selection to tenant settings.

**Review prompt:** Review settings clarity and future extension path.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-010A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-010B — Terminology preference controls

> **Size:** S | **Layer:** Settings | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P4-010A

**Allowed files:** `packages/api/src/settings/**`

**Build prompt:** Allow terminology preferences that change display language without changing canonical data model.

**Review prompt:** Review product clarity and maintenance implications.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-010B"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-011A — Vertical-aware estimate quality metric model

> **Size:** S | **Layer:** Analytics | **AI Build:** Medium | **Human Review:** Moderate

**Dependencies:** P1-009F, P4-009B

**Allowed files:** `packages/api/src/*/analytics.**`

**Build prompt:** Define metric model for estimate quality by vertical, category, tenant, and prompt version.

**Review prompt:** Review whether success metrics reflect real beta value.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-011A"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---

### P4-012 — Estimate-acceleration beta benchmark

> **Size:** S | **Layer:** Analytics | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P4-011A

**Allowed files:** `packages/api/src/*/analytics.**`

**Build prompt:** Define manual-vs-AI-assisted estimate benchmark for HVAC and plumbing beta.

**Review prompt:** Review whether benchmark reflects speed and quality, not just novelty.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-012"
```

**Required tests:**
- [ ] Happy path test
- [ ] Validation test — invalid input rejected with clear errors

---
