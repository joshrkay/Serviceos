# Context map

One product, three bounded contexts that map onto the npm workspaces. Each context owns its
vocabulary in its own `CONTEXT.md`; system-wide decisions live in `docs/decisions.md` (D-NNN).
How skills consume these files: `docs/agents/domain.md`.

| Context | Owns | Glossary |
|---|---|---|
| `packages/api` | the backend: voice surfaces (phone / memo / chat), proposals and approval, lookups, telephony, billing, RBAC | `packages/api/CONTEXT.md` |
| `packages/web` | the operator UI: inbox, approval queue, dispatch board, settings | `packages/web/CONTEXT.md` — create when a term is coined |
| `packages/shared` | the contracts both sides agree on: proposal types, action classes, wire schemas, enums | `packages/shared/CONTEXT.md` — create when a term is coined |

`packages/mobile` and `packages/voice-eval` are supporting packages: they use `api`'s and
`shared`'s vocabulary and do not own terms.

When a term belongs to more than one context, the owner is the package whose code defines it;
the other context's glossary links rather than redefines.
