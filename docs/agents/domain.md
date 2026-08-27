# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it says which package owns which vocabulary and points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/decisions.md`** — this repo's ADR log. Decisions are the `D-NNN` entries (D-001 …), newest last, each with **Date / Initiative / Decision / Rationale / Constraints**. Read the entries that touch the area you're about to work in, and cite them as `D-NNN`. Two longer-form decisions live alongside it in `docs/decisions/`.
- **`packages/<context>/docs/adr/`** — context-scoped decisions, when a package has them.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Multi-context repo (one product, three bounded contexts that map onto the npm workspaces):

```
/
├── CONTEXT-MAP.md                      ← which context owns which vocabulary
├── docs/decisions.md                   ← system-wide ADRs (D-001 … D-NNN)
├── docs/decisions/                     ← long-form system-wide decisions
└── packages/
    ├── api/
    │   ├── CONTEXT.md                  ← backend vocabulary (voice surfaces, proposals, lookups, telephony, RBAC…)
    │   └── docs/adr/                   ← api-scoped decisions (created lazily)
    ├── web/
    │   ├── CONTEXT.md                  ← operator-UI vocabulary (created lazily)
    │   └── docs/adr/
    └── shared/
        ├── CONTEXT.md                  ← contract vocabulary both sides agree on (created lazily)
        └── docs/adr/
```

`packages/mobile` and `packages/voice-eval` are supporting packages: they use `api`'s and `shared`'s vocabulary and do not own terms.

## Where a new decision goes

- Affects more than one package, a cross-cutting invariant (money, tenancy, proposal-first, RBAC), or a product posture → a new `D-NNN` entry in `docs/decisions.md`, same field format as its neighbours.
- Scoped to one package's internals → `packages/<context>/docs/adr/NNNN-<slug>.md`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the owning context's `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing decision, surface it explicitly rather than silently overriding:

> _Contradicts D-004 (proposal-first) — but worth reopening because…_
